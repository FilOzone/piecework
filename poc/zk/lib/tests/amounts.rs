//! Parsing money is where this job can be quietly wrong, and a wrong total here gets proved and paid for.
//! The proof says the computation ran over the client's data; it says nothing about whether the arithmetic
//! means what the client thinks. So the cases that matter are the ones where a guess would be plausible.
use piecework_lib::{format_cents, parse_amount, sum_amounts};

#[test]
fn reads_the_shapes_a_client_would_write() {
    assert_eq!(parse_amount("4800.00"), Some(480_000));
    assert_eq!(parse_amount("4,800.00"), Some(480_000));
    assert_eq!(parse_amount("invoice-2, 4800.00"), Some(480_000));
    assert_eq!(parse_amount("  $1234.56  "), Some(123_456));
    assert_eq!(parse_amount("-99.99"), Some(-9_999));
    assert_eq!(parse_amount("7"), Some(700));        // no decimal part is seven whole units
    assert_eq!(parse_amount("7.5"), Some(750));      // one decimal place is tenths, not hundredths
}

/// A line that cannot be read must not be read as zero. Silently treating a header or a currency code as
/// nothing would produce a total that is wrong in the one direction nobody checks — too small.
#[test]
fn refuses_rather_than_guesses() {
    assert_eq!(parse_amount("amount"), None);
    assert_eq!(parse_amount("4800.000"), None);      // more precision than cents
    assert_eq!(parse_amount("1.2.3"), None);
    assert_eq!(parse_amount("12 USD"), None);
    assert_eq!(parse_amount(""), None);
    assert_eq!(parse_amount("-"), None);
}

#[test]
fn totals_and_says_what_it_could_not_read() {
    let file = "amount\n4,800.00\n2350000.00\n\nnot a number\n-99.99\n";
    let (total, counted, skipped) = sum_amounts(file.as_bytes());
    assert_eq!(counted, 3);
    assert_eq!(skipped, 2);                           // the header and the junk line
    assert_eq!(total, 480_000 + 235_000_000 - 9_999);
    assert_eq!(format_cents(total), "2354700.01");
}

/// Integer cents, so the result does not depend on the order the lines happen to be in. The same property
/// in binary floating point does not hold, and the failure would be invisible: a total that is correct on
/// one machine and a penny out on another, both proved.
#[test]
fn order_does_not_change_the_total() {
    let a = sum_amounts(b"0.10\n0.20\n0.30\n").0;
    let b = sum_amounts(b"0.30\n0.10\n0.20\n").0;
    assert_eq!(a, b);
    assert_eq!(a, 60);
    assert_eq!(format_cents(a), "0.60");
}

#[test]
fn formats_back_to_what_a_person_would_write() {
    assert_eq!(format_cents(0), "0.00");
    assert_eq!(format_cents(5), "0.05");
    assert_eq!(format_cents(-5), "-0.05");
    assert_eq!(format_cents(100), "1.00");
}
