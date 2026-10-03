# Exclusive loans across call arguments

The canonical HIR ownership checker rejects using one `mutref<u64>` binding
twice in the same call, including a local loan and a borrowed function
parameter:

```swyp
fn f(a: mutref<u64>, b: mutref<u64>) -> u64 { return *a + *b; }
fn run() -> u64 {
    let x: u64 = 7;
    let r = &mut x;
    let result: u64 = f(r, r); // exclusive_call_alias
    drop(r);
    return result;
}
```

Exclusive loan construction already checks overlapping storage provenance.
The call check tracks binding identity, not just textual variable names or
the containing storage owner. Distinct local loans, disjoint constant array
indices/struct fields, distinct incoming parameters, repeated shared references
and sequential single-exclusive calls retain their existing behavior.

The regression reproduces the previously accepted typed `u64` example and
verifies rejection through the mandatory HIR-to-Core ownership gate. This
change does not promote a new borrowed parameter ABI or remove capabilities,
contracts, model independence, or any other planned Swyp language feature.
