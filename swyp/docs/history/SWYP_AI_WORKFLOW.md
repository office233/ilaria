# Swyp 0.3: natural-language source, checked expansion and two targets

Status: implemented prototype. The pipeline and failure handling are tested. Successful generation by a live Ilaria model is not verified because the configured loopback service was unavailable. Offline example responses are explicitly labeled fixtures and must not be reported as live AI output.

## Mixed source

```text
fn main() {
    let count = 10;
    #natural: "Calculate the sum of squares from 1 through count inclusive. Store it in a number variable named total.";
    if total == 385 {
        #limbaj_natural: "Afiseaza mesajul Calculation passed urmat de variabila total.";
    } else {
        print("Unexpected result", total);
    }
}
```

Both spellings are supported; intent text can be Romanian or English. Directives must be statement fragments and end with semicolons. Directives inside comments or string values are not executed or expanded.

`expand` sends the selected file and directive list to Ilaria and requests JSON replacements keyed by directive ID. It splices only directive spans; surrounding handwritten code remains unchanged. Each fragment must parse as statements, and the complete expanded program must pass name/type/return checks. Unknown, duplicate, missing or invalid replacements are rejected. It does not silently synthesize APIs that the language does not provide.

```powershell
.\bin\swyp.exe expand -o bin/my-expanded.swyp examples/swyp/intent.swyp
.\bin\swyp.exe check bin/my-expanded.swyp
.\bin\swyp.exe build -o bin/my-app.exe bin/my-expanded.swyp
.\bin\swyp.exe web -o bin/my-app.html bin/my-expanded.swyp
```

The first command requires Ilaria at `http://127.0.0.1:8091`. In this session the service refused connections. The generated program, once saved, runs without an LLM. `run`, `check` and `build` explain how to expand when given unresolved directives.

## Reproducible offline pipeline test

The included JSON is an authored response fixture. It tests compiler integration without claiming that a model understood the prompt.

```powershell
.\bin\swyp.exe expand -response examples/swyp/intent.response.json -o bin/intent-expanded.swyp examples/swyp/intent.swyp
.\bin\swyp.exe run bin/intent-expanded.swyp
.\bin\swyp.exe build -o bin/intent-native.exe bin/intent-expanded.swyp
.\bin\intent-native.exe
.\bin\swyp.exe web -o bin/swyp-intent.html bin/intent-expanded.swyp
```

The interpreter and native executable both produced `Calculation passed 385`. Output files must be new; choose a different name if repeating the commands. The web file contains a small HTML interface and a generated JavaScript worker. It makes no model or network calls. The JS backend passes numerical, scope, evaluation-order, short-circuit, error and string tests under Node. The browser interface has not been visually verified: the integrated browser rejected `file://` access, and no alternative route was used to bypass that policy.

Generated source has a companion `.lock.json` with operation, backend label, original/output SHA-256 and validation status. This is provenance metadata, not a signature or proof. Builds do not currently enforce the manifest. Model/checkpoint identity is explicitly unknown when the service does not report it. Editing generated code changes its hash; preserve the original manifest as generation history rather than claiming it verifies later edits.

## Repair drafts

```powershell
.\bin\swyp.exe repair -o bin/proposed-fix.swyp examples/swyp/repair.swyp
```

The command obtains a syntax/type diagnostic, asks Ilaria for a corrected complete program and validates it. It saves a separate candidate; it does not replace the original, execute the result or resume production automatically. If the source already passes static checks, the command reports that there is no static diagnostic to repair. Logical defects can still exist.

Offline fixture test, verified to print 385:

```powershell
.\bin\swyp.exe repair -response examples/swyp/repair.response.swyp -o bin/repair-preview.swyp examples/swyp/repair.swyp
.\bin\swyp.exe run bin/repair-preview.swyp
```

This fixture corrects a misspelled variable. A static check cannot establish that a proposed correction preserves all business behavior. Whole-program repair output should be reviewed as a candidate change. No automatic mathematical safety guarantee is claimed.

## Scope and remaining requirements

The implementation establishes the requested intent-to-code pipeline using supported scalar operations. It does not implement SMS, email, payments, database creation, arbitrary module imports or a full UI renderer. Those need explicit runtime/provider interfaces and independent tests. It does not promise infinite libraries, zero crashes, instantaneous compilation or maximum performance on every device.

Current targets are Windows native through C/GCC and JavaScript emitted into an HTML worker runner. They are different outputs from one expanded source, not one binary for all hardware. Mobile packaging, WebAssembly and other native platforms remain unimplemented or untested.

Next gate: successful real-model intent and repair evaluations on unseen tasks, with independent behavior tests. Then introduce typed provider modules and a declarative UI subset. Keep the existing SwypikOS application while validating each new capability.
