// SPDX-License-Identifier: Apache-2.0 OR MIT
pragma solidity ^0.8.27;

/// @title MockPDP (local POC only)
/// @notice Stand-in for PDPVerifier on a local chain, where no real storage provider proves possession.
///         Keeps, per data set, a list of pieces (name + piece CID string) and whether each is live.
///         Exposes `pieceLive` and `getNextPieceId` with the same signatures and numbering as FilOzone/pdp
///         PDPVerifier @ 4d6b30f (piece ids start at 0 and only grow while the data set is live).
///         On calibnet (stage B) this is replaced by the real PDPVerifier.
contract MockPDP {
    struct Piece {
        string name;
        string pieceCid;
        bool live;
    }

    mapping(uint256 => address) public dataSetOwner;          // the storage provider of the data set
    mapping(uint256 => Piece[]) internal pieces;               // pieceId = index
    uint256 public nextDataSetId = 1;

    event DataSetCreated(uint256 indexed setId, address indexed provider);
    event PieceAdded(uint256 indexed setId, uint256 indexed pieceId, string name, string pieceCid);

    function createDataSet() external returns (uint256 setId) {
        setId = nextDataSetId++;
        dataSetOwner[setId] = msg.sender;
        emit DataSetCreated(setId, msg.sender);
    }

    /// Only the provider holding the data set can add pieces (as in PDP, where the SP submits addPieces).
    function addPiece(uint256 setId, string calldata name, string calldata pieceCid) external returns (uint256 pieceId) {
        require(msg.sender == dataSetOwner[setId], "not the data set's provider");
        pieceId = pieces[setId].length;
        pieces[setId].push(Piece(name, pieceCid, true));
        emit PieceAdded(setId, pieceId, name, pieceCid);
    }

    function pieceLive(uint256 setId, uint256 pieceId) external view returns (bool) {
        return pieceId < pieces[setId].length && pieces[setId][pieceId].live;
    }

    function getNextPieceId(uint256 setId) external view returns (uint256) {
        return pieces[setId].length;
    }

    function getPiece(uint256 setId, uint256 pieceId) external view returns (string memory name, string memory pieceCid, bool live) {
        Piece storage p = pieces[setId][pieceId];
        return (p.name, p.pieceCid, p.live);
    }
}
