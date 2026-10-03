# Swyp Lang 0.14 experimental

Version 0.5 supports a separate `validation` array in synthesis specifications.
The engine refines candidates using failing points and enforces one total
candidate budget across rounds. See [the example](../../../swyp/examples/swyp/synthesis-refine.json).
Numeric example fields must be present and non-null. Contradictory outputs for
the same numeric input are rejected before search. Verification covers only the
supplied points; it is not a universal proof.

Version 0.4 adds `swyp synth -o new.swyp spec.json`: bounded deterministic
arithmetic synthesis from examples with no LLM calls. See [the status report](../../agent-md/swyp/history/NON_LLM_STATUS.md)
for tested capabilities, restrictions and reproducible evaluation.

The native backend has two explicit profiles. `safe` preserves operation-level
fuel accounting and batches checks without changing observed failure boundaries.
`fast` is the AOT compute profile: it keeps finite-float checks,
division/remainder traps and call-depth limits, but accounts execution budget at
function entries and loop backedges and compiles with `-O3`. Exact safe-profile
fuel counts are therefore not portable to `fast`.

Swyp Lang is our experimental language, previously called Syra in the research proposal. Files use `.swyp`. Version 0.2 adds static checking, native compilation through C/GCC, numeric command-line inputs, interval timing, and an optional Ilaria draft-generation command.

Version 0.3 adds inline natural-language statements, validated expansion with provenance, separate repair drafts, and an offline HTML/JavaScript target. See [the end-to-end walkthrough](../../agent-md/swyp/history/SWYP_AI_WORKFLOW.md). These are implemented mechanisms, not a claim of general natural-language correctness.

This is a scalar prototype, not a replacement for SwypikOS. See [0.2 measurements](../../agent-md/swyp/history/SWYP_NATIVE_ASSESSMENT.md), [historical 0.1 measurements](../../agent-md/swyp/history/SWYP_MIGRATION_ASSESSMENT.md), and [the requested AI-language vision](../../agent-md/swyp/history/SWYP_VISION.md).

## Run and build

From the project root in PowerShell:

```powershell
go build -o bin/swyp.exe ./cmd/swyp
.\bin\swyp.exe check examples/swyp/hello.swyp
.\bin\swyp.exe run examples/swyp/hello.swyp
.\bin\swyp.exe build -o bin/hello-swyp.exe examples/swyp/hello.swyp
.\bin\hello-swyp.exe
.\bin\swyp.exe build -o bin/swyp-compute.exe examples/swyp/compute.swyp
.\bin\swyp-compute.exe 2 200
.\bin\swyp.exe run -steps 1000000000 examples/swyp/compute.swyp 2 200
```

Native compilation requires GCC on PATH and emits C11 with `-O2 -ffp-contract=off`, without fast-math. This uses an existing compiler, not an AI optimizer. `emit-c file.swyp` prints inspectable generated C. CLI options precede the filename.

`compute.swyp` mode 0 runs Mandelbrot (second input: width); mode 1 counts primes (second input: limit); mode 2 trains linear regression (second input: epochs).

## Language and checks

```text
fn square(x: number) -> number {
    return x * x;
}
fn main() {
    let count = 1;
    while count <= 5 {
        print("square", count, "=", square(count));
        count = count + 1;
    }
}
```

- Parameter types: `number`, `bool`, `string`; return types also allow `void`. Inference is monomorphic: a function cannot accept both strings and numbers at separate calls. Unresolved function types require annotations.
- `let` creates a mutable fixed-type block-scoped variable. Assignment updates the nearest binding; nested blocks can shadow outer variables. Duplicate declarations in one block are rejected.
- Numbers are finite IEEE 754 float64 values. Integers beyond 2^53 can round. Arithmetic overflow to infinity is rejected; ordinary floating-point rounding remains. There is no integer type yet.
- Operators: `+ - * / %`, `< <= > >=`, `== !=`, `! && ||`. Conditions must be boolean; logical operators short-circuit. Different scalar value types compare unequal.
- Statements: `if condition { ... } else { ... }`, `while condition { ... }`, `return expression;`. Value-returning functions must have a recognized return on every path. The conservative checker does not prove that a loop always returns.
- Semicolons terminate simple statements. Braces delimit blocks. Double-quoted strings support escapes. Line/block comments are supported; interpolation is not.
- String concatenation works in the interpreter and is explicitly rejected by the native backend. Native immutable strings support passing, returning, equality and printing, including embedded NUL bytes.
- CLI `check`, `run` and `build` validate the whole program, including unreachable branches: names, arity, types, and return coverage. This is not proof that intended behavior is correct.

### Stable diagnostics

Parser/checker failures now carry a machine-readable diagnostic code and source
location while preserving the existing human-readable `file:line:column:
message` text. The source diagnostic contract is versioned independently as
`diagnostic_schema_version: 1`; `swyp language-manifest` publishes the complete
canonical code registry so editors, agents and build systems do not need to
classify compiler failures by matching English text. Core/model-facing JSON
commands preserve these source codes and locations in their existing
`diagnostic` envelope.

### Module preamble (M1 foundation)

Executable/Core sources and declarative component sources now share one common
preamble syntax:

```text
module app.control;
use platform.protocols;
use platform.security;
```

`module` is optional and may appear once; `use` declarations are ordered,
bounded and duplicate-rejected. The common frontend preserves original source
offsets/line numbers when handing the declaration body to the existing parsers.
At this stage `use` is **logical dependency metadata only**: parsing never
performs ambient filesystem/network access and does not yet link imported
symbols. Deterministic dependency resolution is available separately through an
explicit module root:

```powershell
.\bin\swyp.exe module-graph -root .\modules app\main.swyp
```

Logical module `a.b` resolves only to `<root>/a/b.swyp`. The resolver verifies
that the loaded file declares the requested module name, bounds source/module
counts, rejects dependency cycles, prevents resolved paths from escaping the
explicit root after symlink resolution, and records a SHA-256 for every exact
source. The graph step validates dependency identity only; qualified symbol
linking is intentionally deferred to the typed HIR rather than implemented as
an unqualified legacy-parser merge.

### Qualified declaration HIR (M1)

`swyp hir file.swyp` emits HIR JSON v1 shared by executable/Core and declarative
component sources. HIR symbols have stable qualified identities of the form
`module::kind::name`; function declarations carry typed parameter/result
signatures plus typed statement/expression bodies, and declarative records carry
typed fields. Legacy scalar modules use the existing checker to preserve
inferred `number`/`bool`/`string` semantics. Core modules use semantic systems
types such as `i64`, `u64`, `f64`, `ieee64` and `bytes`.

Calls inside HIR never remain unresolved source strings. A local call becomes a
same-module `SymbolID`; an imported call uses explicit source syntax such as:

```text
module app.main;
use lib.math;

fn run(x: i64) -> i64 {
    return lib.math.square(x);
}
```

and resolves to `lib.math::fn::square`. `swyp hir-link -root DIR root.swyp`
builds a deterministic HIR bundle for the validated module graph. The linker
requires the callee module to appear directly in `use`, checks symbol existence,
arity and exact argument/result types, and rejects transitive-import shortcuts.
No namespace merge or implicit numeric conversion occurs.

The HIR validator independently checks local scopes, let/assignment/return
types, conditions and operator type rules so a forged HIR JSON body cannot rely
only on the frontend having behaved correctly.

Core-module source now also accepts nominal `struct` and `enum` declarations at
the HIR layer. Struct fields are named and typed; enum variants are unique and
may carry one typed payload. Function signatures may reference local nominal
types, including forward references. Qualified nominal types such as
`lib.types.User` require a direct `use lib.types`, and linked-bundle validation
verifies that the referenced `struct`/`enum`/`record` actually exists in that
module rather than treating the name as opaque text.

HIR now also carries nominal values, not just schemas. Struct construction is
explicit (`new User { id: ..., active: ... }`) and requires exactly the declared
fields with exact types; postfix projection (`user.id`) resolves against the
linked struct/record schema. Enum constructors use `Type::Variant` or
`Type::Variant(payload)`. `match` is exhaustive, rejects duplicate/unknown arms,
requires payload bindings where appropriate and gives those bindings explicit
HIR types. The same tagged-value machinery backs contextual `option<T>` and
`result<T,E>` constructors (`some`/`none`, `ok`/`err`) and exhaustive
`None`/`Some` or `Ok`/`Err` matches. These richer values still fail closed in the
current Core/native lowering until their runtime representation/ownership rules
are promoted there.

HIR bodies also accept contextual fixed-array literals. For example,
`let x: array<i64,3> = [1,2,3];` produces a typed HIR `array` expression. The
context must provide `array<T,N>`; Swyp does not guess a storage type from an
unannotated literal. Length must equal `N` exactly and every element must type
check as `T`, including recursively nested fixed arrays. Postfix indexing on
arrays/slices requires a `u64` index and returns exactly `T`. Slice views use
`value[start:end]` with explicit `u64` bounds and `[start,end)` semantics; no
implicit copy is represented in HIR. Runtime bounds enforcement and rich-value
Core/native lowering remain intentionally fail-closed.

`swyp hir-layout -root DIR -type TYPE root.swyp` exposes the deterministic
`swyp-fixed-v1` layout planner for values whose representation is already fully
fixed: fixed-width scalars, fixed arrays, structs/records and tagged enums. It
computes field offsets/alignment, array stride and stable declaration-order enum
tags, rejects recursive-by-value layouts and checks size/alignment overflow.
This is a compiler-owned logical fixed-value ABI, **not** the platform C ABI and
not a promise for dynamic descriptors.

`swyp hir-descriptor -root DIR -type TYPE root.swyp` exposes the separate
`swyp-descriptor-v1` logical contract for `slice<T>`, `vec<T>`, `ref<T>` and
`mutref<T>` when `T` already has `swyp-fixed-v1` layout. Descriptors use an
opaque `storage_id` rather than a native pointer. Slice descriptors carry
element offset/length; vec carries length/capacity; ref/mutref carry a byte
offset. Element stride is derived from fixed layout. The contract requires
overflow-safe address arithmetic, `length <= capacity`, `index < length` and
`start <= end <= length`; helper validation rejects invalid descriptors/ranges
before any future storage dereference. This is still a logical ABI: storage
allocation/lookup and Core/native lowering are not implemented by this command.
`string`, `bytes`, `opaque`, `option`, `result` and tuple layout remains outside
this descriptor contract (the existing Core `bytes` ABI stays separate).

`swyp hir-bounds -root DIR root.swyp` emits deterministic bounds evidence for
every HIR array/slice index or range. Fixed-array accesses with literal `u64`
bounds are `proven` when statically in range; accesses depending on runtime
values or slice descriptor length are `runtime_required`. Provably invalid
constant indices, reversed ranges and constant ranges beyond a fixed-array
length are diagnostics. Evidence alone never removes a runtime check; future
lowering may elide one only for a corresponding `proven` access.

The first richer-value subset is now promoted through Core/native execution:
local fixed arrays whose element type is already a Core scalar may be initialized
from an array literal and indexed with a compile-time `u64` index. HIR→Core
scalarizes each element into ordinary Core slots, so the resulting program reuses
the existing verifier/executor/optimizer/x64/ARM64 backends with no descriptor or
raw-pointer ABI. The lowerer independently checks the index against the fixed
length before scalarization. Whole-array assignment, array parameters/results,
dynamic indices, slices and nested aggregate storage remain fail-closed and will
use the descriptor/storage path rather than silently widening this optimization.
Dynamic `u64` indexing is also supported for scalarized fixed arrays up to 64
elements: HIR→Core emits a bounded CFG that selects one scalar slot and sends any
out-of-range path to `unreachable`. Core execution reports that sink as an error;
the x64/ARM64 machine ABI maps it to the existing bounds failure status `3`
instead of trapping the host process. Constant OOB remains a compile-time
lowering error.

Local slice views over scalarized fixed arrays are now promoted without a raw
pointer or storage allocator. A binding such as `let s = xs[1:4];` with
compile-time `u64` range bounds becomes a view over the selected scalar Core
slots. Constant and dynamic `s[i]` reuse the same checked indexing path as fixed
arrays, including the bounded CFG and `unreachable` OOB sink. Dynamic slice
range construction over a fixed scalarized array is also supported: the lowerer
checks runtime `start <= end <= N`, then each `s[i]` checks
`i < end-start` before selecting `start+i`. Invalid ranges and OOB indices enter
the same checked failure sink. Slice parameters/results and descriptor-backed
storage are still fail-closed for `swyp-descriptor-v1` lowering.

The first real Core storage ABI is now implemented for interpreter execution.
Core IR defines pure bounded operations `storage.alloc_u64`,
`storage.load_u64`, `storage.store_u64` and `storage.free`. Backing storage is
owned per execution run, uses opaque monotonic non-reused IDs, and performs
checked little-endian `u64` access. Run, RunFast and RunTurbo share the same
semantics; concurrent runs do not share backing storage.

HIR automatically uses this path for local `array<u64,N>` and `array<i64,N>` values above the
64-element scalarization threshold. Indexing becomes `storage.load_u64`, and
slice views over these arrays carry `(storage_id,start,end)` in Core slots with
checked range/index arithmetic. Standalone x64/ARM64 now implement the same
bounded `storage.*` contract in the existing RW process-data section. Storage
uses opaque monotonic descriptor IDs and a region partitioned from the mutable
`fs.read`/`net.fetch` arena; failures map to the existing bounds status instead
of exposing raw pointers. Windows x64 is runtime-tested; ARM64 is structurally
and cross-build validated on this workstation. Packed modules remain stateless
and continue to reject `storage.*`.

Local `vec<u64>`, `vec<i64>`, `vec<ieee64>` and `vec<bool>` owners use that
storage contract directly.
Signed `i64` values are reinterpreted bit-exactly at the storage boundary through
verified non-trapping Core bitcasts; storage never numerically converts them.
Each bool occupies one raw64 word: `false` encodes as `0`, `true` as `1`.
Encoding branches on a typed Core bool; decoding checks `word <= 1` before
comparing with `1`. Noncanonical words trap instead of becoming truthy values,
and no bool/numeric cast is introduced. This is the raw64 lowering representation,
not a change to the logical `swyp-fixed-v1` bool size/alignment (one byte) or to
`swyp-descriptor-v1`. Large local `array<bool,N>` values above the existing
64-element scalarization threshold reuse the same encoding, indexing and refs.
A contextual literal such as `let v: vec<i64> = [-10,20,30];` allocates owned storage;
`v[i]` is checked; `v[start:end]` is a borrowed slice view; and `drop(v)` emits
`storage.free`. `&v[i]` / `&mut v[i]` lower to checked descriptor-backed
`(storage_id,index)` references, including dynamic indices, so dereference/store
does not materialize a native pointer. `vec_len(v)` and `vec_capacity(v)` inspect
metadata without consuming the move-only owner.

`vec_push(v, value)` is implemented for storage-backed raw64 vecs across structured CFG
control flow. Capacity is reused when available; a full vec grows x2 into a
new bounded storage block, copies existing elements through checked
`storage.load_u64`/`storage.store_u64`, frees the old block and updates the local
descriptor. Ownership rejects push while any overlapping borrow is live. Push
inside `if`/`while` is represented by mutable Core descriptor slots so SSA
creates the required joins/backedge phis.

Storage-backed raw64 vec parameters, including `vec<bool>`, cross the
linked-HIR/Core function ABI explicitly as
three `u64` values `(storage_id, length, capacity)`. A callee reconstructs the
descriptor view locally and may index it, inspect metadata, grow it and consume
the owner with `drop`. Callers flatten only an existing storage-backed vec
binding, so no raw pointer or hidden allocation crosses the boundary. Local and
cross-module calls are covered. Raw-64 vec results now use a single explicit Core
`u64` descriptor handle: the callee allocates a 3-word storage descriptor
`(storage_id,length,capacity)`, returns its opaque handle, and the caller loads
those three fields then immediately frees only the descriptor block. Ownership of
the underlying vec storage transfers to the caller, which remains responsible
for `drop(v)`. This preserves Core's one-result-slot ABI without inventing a
hidden out-pointer. Local and cross-module vec returns are runtime-tested on x64
Windows and structurally validated for ARM64. Element layouts beyond raw 64-bit
storage remain fail-closed.

Move-owned local vecs also have an explicit deterministic scope-cleanup contract:
`defer_drop(v)`. It schedules exactly one cleanup for a move-owned binding declared
in the current lexical scope. The owner remains available for inspection and
mutation until scope exit, but assignment, ownership transfer, manual `drop(v)`
or a second `defer_drop(v)` are rejected. Core lowering emits `storage.free` in
reverse registration order on normal scope exit and before every `return` that
leaves the scope. This is explicit deterministic cleanup, not a GC or a hidden
host finalizer. V1 Core lowering intentionally limits deferred cleanup to
storage-backed vec owners. A moved vec parameter may also be scheduled from the
function's top-level body; scheduling a parameter from a nested block remains
rejected so destruction cannot become branch-dependent in v1. Other move-owned
resources remain explicit-drop-only.

Storage-backed vecs now also support a first compound element layout: a flat
`struct`/`record` whose fields are all raw-64 storage scalars (`u64`, `i64`,
`ieee64` or canonical `bool` words). The vec descriptor is unchanged—`length`/`capacity` remain element
counts—while the backing allocation uses a fixed word stride equal to the field
count. Literals store fields in declaration order; `v[i].field` performs checked
element bounds plus stride/field addressing; `vec_push` grows/copies the backing
store in words while preserving element-count metadata. The same descriptor ABI
crosses function parameters and opaque vec-return handles, including qualified
cross-module nominal types. Mixed `u64`/`i64`/`ieee64` fields are bit-preserving;
bool leaves use the checked canonical encoding, including field refs and Copy loads.
Flat raw64 struct elements can also be materialized by Copy (`let p: Pair =
v[i]`) into the existing scalarized local-struct representation. Field places
inside storage vec elements support shared/mutable descriptor refs such as
`&v[i].field` / `&mut v[i].field`; the ref remains `(storage_id,word_index)` and
never materializes a native pointer. Dynamic indices are bounds-checked before
stride addressing.

Read-only `slice<Struct>` views over such vecs now keep `(storage_id,start,end)`
in **element units**. `s[i].field`, `let p: Pair = s[i]`, and shared
`&s[i].field` apply stride only at load/ref formation time, with checked slice
bounds first. `&mut` through `slice<T>` remains intentionally fail-closed until
the language has an explicit mutable-slice contract.

By-value struct/record nesting is also flattened recursively when **every leaf**
is raw64. Storage order follows declaration order depth-first, so constructors and
`vec_push` can encode nested values while leaf paths such as
`v[i].inner.value`, `&mut v[i].inner.value`, `s[i].inner.value` and shared slice
refs compute the same deterministic word offset. The vec/slice descriptors stay
unchanged and all bounds are still checked in element units before stride math.
Recursive-by-value layouts and non-raw64 leaves remain rejected. The existing
recursive local scalarization also supports whole-element Copy from vec/slice
storage and local leaf refs for nested raw64 aggregates; bool leaves reuse
those paths. This does not promote general whole-aggregate assignment, variable
aggregate values for `vec_push`, aggregate parameters/results or new destructors.

Bool storage is covered by Run/RunFast/RunTurbo and differential Core/native
execution on Windows x64 and Linux x64/AArch64 (QEMU), including static ELF and
PIE. Checked descriptor OOB and noncanonical bool decode failures use the
existing HIR `unreachable` guard and native failure exit `1`; direct storage OOB
uses Core's `bounds` diagnostic. Physical AArch64 execution is not claimed.

Core `bytes.from_storage_u64(id,length)` produces an immutable snapshot of a
live storage prefix, checking length, capacity, octet values and arena budget
before publishing it. The snapshot survives source mutation or `storage.free`.
Pure Go/C execution has an additional 1 MiB snapshot arena; effect execution
shares the caller's `MaxBytes` budget. Native process snapshots share the 64 KiB
runtime byte arena, including its eight-byte cursor reservation. These budgets
are not interchangeable. Native `fs.write` accepts committed runtime bytes as
data, while its filename remains immutable module bytes. Internal Bytes
parameters/results are supported only for standalone process mode, not scalar
process entry, stateless packed modules or object-call ABIs.

Local fixed structs whose fields are all already Core-scalar are promoted by the
same strategy. A `new Struct { ... }` local is decomposed into one Core slot per
field and `value.field` projects the corresponding slot, so no native struct ABI
or hidden pointer representation is introduced. Struct parameters/results,
non-raw64 nested fields, move-owned/dynamic fields and whole-struct assignment
remain fail-closed until their ABI/ownership contracts are promoted explicitly.

Compile-time-known tagged sums have a similarly narrow promotion path. A local
`option<T>`, `result<T,E>` or nominal enum initialized directly with a known
variant may be matched in the same function when its payload is Core-scalar.
HIR→Core keeps only the selected variant payload and lowers the chosen match arm;
no runtime tag layout is invented. Sum parameters/results, values returned from
calls, reassignment, dynamic variant selection and non-Core payloads remain
fail-closed for the future tagged-union ABI.

Local `ref<T>` / `mutref<T>` now have two Core/native promotion paths. Statically
resolvable scalar places are compile-time aliases to existing Core slots. In
addition, indexed places inside storage-backed raw64 vecs and large scalar arrays lower to an
opaque `(storage_id,index)` descriptor after an explicit bounds guard; constant
and dynamic indices both work. `*r` loads through the appropriate path,
`store(r,value)` writes through `mutref`, and `drop(r)` ends the source-level
loan without exposing a native pointer. References still cannot cross the Core
function ABI. Aggregate slice leaf refs are shared-only; scalar slice refs and
mutable slice refs remain fail-closed. Descriptor refs to layouts beyond the
supported raw64 leaves remain fail-closed.

`swyp hir-ownership -root DIR root.swyp` is the first affine ownership gate for
linked HIR. It classifies values recursively as `copy`, `move` or `borrowed`:
fixed scalar/aggregate values are Copy when all members are Copy; `vec`,
`string` and `opaque` are move-only; `slice<T>` is a borrowed view. The checker
detects use-after-move, unconsumed move values, implicit drop on reassignment,
unbalanced moves across `if`/`match`, ownership-changing loops and borrowed
returns without a lifetime contract. `drop(x)` is an explicit HIR-only affine
consumption operation.

Lexical immutable/mutable borrows are now source-visible in the HIR path:
`let r = &x;` and `let r = &mut x;` produce `ref<T>` / `mutref<T>`. Shared borrows
may coexist; a mutable borrow is exclusive; assignment/move/direct use that
conflicts with an active borrow is rejected. `*r` is currently allowed only for
Copy referents, and `store(r, value)` mutates through `mutref<T>` only when `T`
is Copy. `drop(r)` may end a lexical borrow early; otherwise it ends at scope
exit. Mutable references cannot be copied into another binding.

Call checking rejects duplicate use of the same existing `mutref` in a single
call; existing overlapping-place loan checks remain in force. Shared/shared,
proven-disjoint and sequential calls remain valid. Duplicate-exclusive rejection
uses `exclusive_call_alias`; see [the regression](EXCLUSIVE_CALL_LOANS.md).

Borrowed results now require an explicit source relationship on the function:

```text
fn identity(x: ref<u64>) -> ref<u64> borrows x {
    return x;
}
```

`borrows x` is part of HIR (`borrow_from`) and must name a borrowed parameter
(`ref<T>`, `mutref<T>` or `slice<T>`). The ownership checker verifies returned
provenance against that parameter, propagates it through local reborrows and
through calls to other lifetime-annotated functions, and rejects mismatched or
missing callee contracts. A derived mutable return remains exclusive until its
binding is released. Borrowed returns without a contract remain rejected.
Borrowing a field or indexed element is allowed even when the projected type is
non-Copy. Static field paths now participate in place-disjoint analysis: mutable
loans on `x.left` and `x.right` may coexist, while `x.left` and `x.left.inner`
overlap and conflict. Constant array indices also participate in place analysis:
`&mut x[0]` and `&mut x[1]` may coexist, including under a static field path.
Dynamic indices remain conservative at their indexed container (`x[i]` conflicts
with `x[j]` and with a constant projection of the same container). Constant
half-open slice ranges also participate in overlap checks: `[0:2]` is disjoint
from index `3` and range `[2:4]`, but overlaps index `1`; dynamic ranges remain
container-conservative. Moving, dropping or reassigning the root owner remains
blocked while any loan is active.
Moving fields/indexed non-Copy elements by value
is still rejected until partial-move semantics exist. The command emits deterministic JSON and exits non-zero on
diagnostics; it remains an explicit promotion gate rather than an implicit rule
for legacy commands.

Linked HIR now lowers into the **existing** Semantic Core and native backends:

```powershell
swyp hir-core       -root .\modules -entry run -o linked.core.json app\main.swyp
swyp core-exec      -entry run linked.core.json 9
swyp hir-x64-pack   -root .\modules -entry run -o app.swx64 app\main.swyp
swyp hir-arm64-pack -root .\modules -entry run -o app.swa64 app\main.swyp
swyp hir-x64-exe    -root .\modules -entry run -format pe -o app.exe app\main.swyp
swyp hir-arm64-exe  -root .\modules -entry run -o app-arm64 app\main.swyp
```

`hir-core` emits ordinary Core IR JSON and therefore uses the same decoder,
verifier/executor and canonical IR hash as single-file Core. Reachable imported
symbols are deterministically mangled after linking while the requested root
entry keeps its source name. Packed linked-HIR artifacts remain pure-only, just
like the existing packed backend.

Standalone linked-HIR executables use the same process runtime and capability
checks as `core-x64-exe` / `core-arm64-exe`. Sensitive authority remains
explicit: imported `fs.read`, `fs.write`, `net.connect`, `net.fetch` and
`process.exec` requirements propagate to the root and require the corresponding
CLI grant. `process.exec` still fails closed after the grant because its native
runtime policy is intentionally not implemented yet.

This remains an incremental migration: the old single-file execution commands
still parse their existing source path directly, while modular applications use
the explicit HIR graph/link/lower path. The next boundary is descriptor storage
runtime/Core-native lowering plus finer dynamic place refinement—not another
parallel syntax island.

Library modules used for HIR/module-graph work do not require `fn main()`. This
does not weaken executable validation: the existing `Parse`/`ParseCore` paths
used by run/build/native commands still require a zero-argument `main`; only the
explicit module parser paths omit the entrypoint requirement.

`print(...)` writes space-separated values and a newline. Native numbers use 17 significant digits; interpreter formatting uses Go's default. Compare numeric values rather than assuming byte-identical floating-point text. Void calls cannot be stored or used as values.

`arg(index)` reads finite numeric CLI arguments from index zero. Invalid indices fail. `clock()` returns seconds for interval measurement; its origin is unspecified. Windows uses QueryPerformanceCounter. The untested non-Windows C fallback uses wall-clock time and is subject to clock adjustments.

Interpreter budget: 1,000,000 steps by default, configurable with `-steps`. Native budget: fixed 1,000,000,000 steps. Both limit call depth to 128. Parsing limits source to 1 MiB and nesting to 256. These are guardrails, not a secure sandbox or memory quota. Native execution retains arithmetic and budget checks. The internal Go `Program.Run` API retains the dynamic interpreter for differential tests; CLI paths call `Check` first.

## Natural-language drafts

```powershell
.\bin\swyp.exe draft -prompt examples/swyp/draft-task.txt -o examples/swyp/my-draft.swyp
```

This calls the configured Ilaria service with a language specification generated from the compiler's current capability metadata and the chosen task text. `SWYP_ILARIA_ENDPOINT` selects the endpoint and defaults to `http://127.0.0.1:8091`; authenticated HTTPS uses `SWYP_ILARIA_TOKEN`. It parses and type-checks the reply, then writes a new source file. It neither overwrites files nor automatically compiles or executes the result. Unsupported requests, invalid source, Markdown responses, and unavailable models produce errors. `swyp language-manifest` prints the machine-readable compiler capability surface used to keep AI tooling aligned with the actual language version.

The real service refused connections during this session. Controlled backend tests passed, but successful generation with a real model remains unverified. No model was downloaded, substituted, or trained. The adapter sends only its instructions and the task text, not the whole repository.

Inline `#natural` and `#limbaj_natural` directives can now be expanded with `swyp expand`. `swyp repair` generates a separate checked candidate for a static diagnostic. Both support explicitly labeled offline response replay for tests. Automatic production repairs, editor UI, provider integrations, and cross-platform publishing remain future work. Saving generated source before compiling makes builds reproducible without an LLM on every build.

## Actual training and tests

The training example performs batch gradient descent on 256 generated samples of `y = 2*x + 1`. Starting at zero, it updates one weight and one bias and reports them with mean squared error. This is real training, but has no autodiff, tensors, GPU kernels, or LLM architecture.

```powershell
go test ./internal/swyplang ./cmd/swyp
go vet ./internal/swyplang ./cmd/swyp
python benchmarks/swyp/run.py
```

Native parity tests compile temporary programs with GCC, explicitly skipping if it is missing. Benchmark references cover C, C++, Go, Python, and Rust when rustc is available. Generated executables go under `bin/swyp-bench`; raw results and source hashes go into `benchmarks/results/SWYP_NATIVE_BENCHMARK.json`.

The new `web -o new.html file.swyp` target produces a scalar runner, not a declarative UI framework. The generated program runs in a worker with Stop, a 10-second timeout and a 1,000-line output limit. The JavaScript core was tested under Node 24; visual browser testing was blocked by the in-app browser's file-URL policy. Browser rendering, worker behavior and controls are not yet end-to-end verified.

Remaining language gaps include arrays/slices, structs/enums, modules/imports,
declarative UI, structured concurrency, resource ownership, foreign-library
adapters, tensors, and production tooling. Capability-gated native filesystem
and narrow network process effects exist in the Semantic Core standalone
backends; they are not ambient legacy-scalar APIs. SwypikOS has not been migrated.
