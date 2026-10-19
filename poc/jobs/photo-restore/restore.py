"""Make the client's photographs bigger and cleaner, next to where they are stored.

Job contract (same for every PieceWork job): read the client's files from /in (read-only), write results to
/out, no network. For each photograph:
  <name>-restored.png      four times the width and height, detail reconstructed rather than interpolated
  photo-restore-report.txt what ran, on what device, how fast, and what it produced

Real-ESRGAN (RRDBNet, 23 blocks, x4), the weights published with the paper. The network is written out here
rather than imported, because the usual package pulls in basicsr, which imports
torchvision.transforms.functional_tensor -- removed in torchvision 0.16. Installing it against a current
torch gives a job that builds and then dies on its first photograph. Sixty lines of well-known architecture
is a smaller liability than a dependency that is wrong on arrival.

Why this is a GPU job rather than a job that is faster on a GPU. Every output pixel passes through 23
residual-in-residual blocks, so a four-times upscale of one 12-megapixel photograph is hundreds of
gigaflops. A processor takes minutes per picture; an archive of ten thousand is weeks. A card takes
about a second. That is the difference between a service and an impossibility, and it is why the report
prints seconds per photograph rather than a total.

Tiled on purpose. Activations for a whole photograph at once would need more memory than any card here
has, and the failure is an out-of-memory error halfway through a client's archive. Tiles overlap by
OVERLAP pixels and are blended, because a seam down the middle of a restored photograph is worse than
a slower job.
"""
import os
import sys
import time

IN, OUT = "/in", "/out"
DEVICE = os.environ.get("DEVICE", "cpu")
WEIGHTS = os.environ.get("WEIGHTS", "/models/RealESRGAN_x4plus.pth")
TILE = int(os.environ.get("TILE", "256"))      # input-side tile; output is four times this
OVERLAP = int(os.environ.get("OVERLAP", "16"))  # trimmed from each inner edge before blending
SCALE = 4
PHOTOS = (".jpg", ".jpeg", ".png", ".webp", ".bmp")
DERIVED = ("-restored.png", "-clean.png", "-mask.png", "-index.txt", "-thumb.jpg")


def build_net(torch, nn):
    class ResidualDenseBlock(nn.Module):
        def __init__(self, nf=64, gc=32):
            super().__init__()
            self.conv1 = nn.Conv2d(nf, gc, 3, 1, 1)
            self.conv2 = nn.Conv2d(nf + gc, gc, 3, 1, 1)
            self.conv3 = nn.Conv2d(nf + 2 * gc, gc, 3, 1, 1)
            self.conv4 = nn.Conv2d(nf + 3 * gc, gc, 3, 1, 1)
            self.conv5 = nn.Conv2d(nf + 4 * gc, nf, 3, 1, 1)
            self.lrelu = nn.LeakyReLU(0.2, inplace=True)

        def forward(self, x):
            x1 = self.lrelu(self.conv1(x))
            x2 = self.lrelu(self.conv2(torch.cat((x, x1), 1)))
            x3 = self.lrelu(self.conv3(torch.cat((x, x1, x2), 1)))
            x4 = self.lrelu(self.conv4(torch.cat((x, x1, x2, x3), 1)))
            x5 = self.conv5(torch.cat((x, x1, x2, x3, x4), 1))
            return x5 * 0.2 + x

    class RRDB(nn.Module):
        def __init__(self, nf=64, gc=32):
            super().__init__()
            self.rdb1, self.rdb2, self.rdb3 = (ResidualDenseBlock(nf, gc) for _ in range(3))

        def forward(self, x):
            return self.rdb3(self.rdb2(self.rdb1(x))) * 0.2 + x

    class RRDBNet(nn.Module):
        def __init__(self, nf=64, nb=23):
            super().__init__()
            self.conv_first = nn.Conv2d(3, nf, 3, 1, 1)
            self.body = nn.Sequential(*[RRDB(nf) for _ in range(nb)])
            self.conv_body = nn.Conv2d(nf, nf, 3, 1, 1)
            self.conv_up1 = nn.Conv2d(nf, nf, 3, 1, 1)
            self.conv_up2 = nn.Conv2d(nf, nf, 3, 1, 1)
            self.conv_hr = nn.Conv2d(nf, nf, 3, 1, 1)
            self.conv_last = nn.Conv2d(nf, 3, 3, 1, 1)
            self.lrelu = nn.LeakyReLU(0.2, inplace=True)

        def forward(self, x):
            feat = self.conv_first(x)
            feat = feat + self.conv_body(self.body(feat))
            for conv in (self.conv_up1, self.conv_up2):
                feat = self.lrelu(conv(torch.nn.functional.interpolate(feat, scale_factor=2, mode="nearest")))
            return self.conv_last(self.lrelu(self.conv_hr(feat)))

    return RRDBNet()


def restore(torch, net, image, dev):
    """One photograph, tile by tile, with the overlap trimmed rather than averaged."""
    _, _, h, w = image.shape
    out = torch.zeros((1, 3, h * SCALE, w * SCALE), dtype=torch.float32)
    step = max(1, TILE - OVERLAP * 2)
    for top in range(0, h, step):
        for left in range(0, w, step):
            bottom, right = min(top + TILE, h), min(left + TILE, w)
            tile = image[:, :, top:bottom, left:right].to(dev)
            with torch.inference_mode():
                big = net(tile).clamp(0, 1).float().cpu()
            # Trim the overlap from edges that are not the picture's own edge, so neighbouring tiles meet
            # on pixels each of them saw full context for.
            ty = 0 if top == 0 else OVERLAP * SCALE
            tx = 0 if left == 0 else OVERLAP * SCALE
            by = big.shape[2] if bottom == h else big.shape[2] - OVERLAP * SCALE
            bx = big.shape[3] if right == w else big.shape[3] - OVERLAP * SCALE
            out[:, :, (top * SCALE) + ty:(top * SCALE) + by, (left * SCALE) + tx:(left * SCALE) + bx] = \
                big[:, :, ty:by, tx:bx]
    return out


def main():
    import numpy as np
    import torch
    from torch import nn
    from PIL import Image

    os.makedirs(OUT, exist_ok=True)
    if not os.path.isdir(IN):
        print(f"no input directory at {IN}", file=sys.stderr)
        return 2
    files = sorted(f for f in os.listdir(IN)
                   if f.lower().endswith(PHOTOS) and not any(f.endswith(d) for d in DERIVED))
    if not files:
        with open(os.path.join(OUT, "photo-restore-report.txt"), "w") as r:
            r.write("No photographs to restore.\n\nThe job looked in /in for "
                    + ", ".join(PHOTOS) + " and found none.\n")
        return 0

    if DEVICE == "cuda" and not torch.cuda.is_available():
        # A GPU job that quietly runs on the processor reports a GPU time for CPU work, which is worse
        # than failing: the number it produces is wrong and nothing says so.
        print("DEVICE=cuda but torch cannot see a GPU", file=sys.stderr)
        return 2
    dev = torch.device(DEVICE)
    net = build_net(torch, nn)
    state = torch.load(WEIGHTS, map_location="cpu", weights_only=True)
    net.load_state_dict(state.get("params_ema", state.get("params", state)), strict=True)
    net.eval().to(dev)
    card = torch.cuda.get_device_name(0) if DEVICE == "cuda" else "CPU"

    started, done, in_px, out_px, in_bytes, out_bytes = time.time(), [], 0, 0, 0, 0
    for name in files:
        path = os.path.join(IN, name)
        picture = Image.open(path).convert("RGB")
        array = np.asarray(picture).astype(np.float32) / 255.0
        tensor = torch.from_numpy(array).permute(2, 0, 1).unsqueeze(0)
        t0 = time.time()
        big = restore(torch, net, tensor, dev)
        seconds = time.time() - t0
        result = (big.squeeze(0).permute(1, 2, 0).numpy() * 255).round().astype(np.uint8)
        out_path = os.path.join(OUT, os.path.splitext(name)[0] + "-restored.png")
        Image.fromarray(result).save(out_path)
        in_px += picture.width * picture.height
        out_px += result.shape[1] * result.shape[0]
        in_bytes += os.path.getsize(path)
        out_bytes += os.path.getsize(out_path)
        done.append((name, picture.size, (result.shape[1], result.shape[0]), seconds))

    elapsed = time.time() - started
    with open(os.path.join(OUT, "photo-restore-report.txt"), "w") as r:
        r.write("Your photographs, enlarged four times\n\n")
        for name, (w0, h0), (w1, h1), seconds in done:
            r.write(f"{name}\n  {w0}x{h0} -> {w1}x{h1}, {seconds:.1f} s\n")
        r.write(f"\nPhotographs: {len(done)}\n")
        r.write(f"Pixels in: {in_px:,}\nPixels out: {out_px:,}\n")
        r.write(f"Read: {in_bytes:,} bytes\nProduced: {out_bytes:,} bytes\n\n")
        r.write(f"Model: Real-ESRGAN x4plus (RRDBNet, 23 blocks), tiles of {TILE} with {OVERLAP} overlap.\n")
        r.write(f"How the job ran: {card}, {elapsed:.1f} s for {len(done)} photograph(s) "
                f"({elapsed / max(1, len(done)):.1f} s each). No network.\n\n")
        r.write("The photographs never left the provider that stores them: only the results did.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
