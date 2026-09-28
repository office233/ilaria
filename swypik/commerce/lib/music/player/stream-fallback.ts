/**
 * Mașina de stări pentru pornirea unui flux cu alternative: încearcă [streamUrl, ...fallbacks]
 * în ordine; trece la următorul URL dacă `playing` nu vine în `timeoutMs` sau dacă apare
 * `error`/`stalled` înainte de pornire. După ce toate eșuează raportează `fail`.
 *
 * `reduceStreamFallback` e pur; `createStreamFallback` îl leagă de un timer (testabil cu fake timers).
 */

export type StreamFallbackState = {
    urls: readonly string[];
    index: number;
    started: boolean;
    /** true cât așteptăm `playing` (timerul de pornire e armat). */
    waiting: boolean;
    failed: boolean;
};

export type StreamFallbackEvent =
    | { type: "playing" }
    | { type: "error" }
    | { type: "stalled" }
    | { type: "timeout" }
    /** Redarea a fost cerută din nou (evenimentul `play`) — rearmăm timerul dacă fluxul n-a pornit. */
    | { type: "play" }
    /** Pauză sau autoplay blocat înainte de pornire — nu e o eroare a fluxului, oprim timerul. */
    | { type: "idle" };

export type StreamFallbackAction =
    | { type: "none" }
    | { type: "try"; url: string }
    | { type: "arm" }
    | { type: "disarm" }
    | { type: "started" }
    | { type: "fail" };

export function initStreamFallback(urls: readonly string[]): StreamFallbackState {
    return { urls, index: -1, started: false, waiting: false, failed: urls.length === 0 };
}

type Step = { state: StreamFallbackState; action: StreamFallbackAction };

function tryNext(state: StreamFallbackState): Step {
    const index = state.index + 1;
    if (index >= state.urls.length) {
        return { state: { ...state, index: state.urls.length, started: false, waiting: false, failed: true }, action: { type: "fail" } };
    }
    return { state: { ...state, index, started: false, waiting: true, failed: false }, action: { type: "try", url: state.urls[index] } };
}

export function startStreamFallback(state: StreamFallbackState): Step {
    return tryNext({ ...state, index: -1, started: false, waiting: false, failed: false });
}

export function reduceStreamFallback(state: StreamFallbackState, event: StreamFallbackEvent): Step {
    const none: Step = { state, action: { type: "none" } };
    if (state.failed || state.index < 0) return none;
    switch (event.type) {
        case "playing":
            if (state.started) return none;
            return { state: { ...state, started: true, waiting: false }, action: { type: "started" } };
        case "timeout":
            return state.waiting && !state.started ? tryNext(state) : none;
        case "stalled":
            return state.started ? none : tryNext(state);
        case "error":
            // și după pornire: fluxul live a căzut — reconectăm la următorul URL.
            return tryNext(state);
        case "play":
            if (state.started || state.waiting) return none;
            return { state: { ...state, waiting: true }, action: { type: "arm" } };
        case "idle":
            if (state.started || !state.waiting) return none;
            return { state: { ...state, waiting: false }, action: { type: "disarm" } };
    }
}

export type StreamFallbackHandlers = {
    /** Setează `src` și cheamă `play()` — sincron, ca să păstreze gestul userului. */
    onTry: (url: string) => void;
    onStarted: () => void;
    onFail: () => void;
};

export type StreamFallbackController = {
    start: () => void;
    handle: (event: Exclude<StreamFallbackEvent, { type: "timeout" }>) => void;
    dispose: () => void;
    getState: () => StreamFallbackState;
};

export function createStreamFallback(
    urls: readonly string[],
    timeoutMs: number,
    handlers: StreamFallbackHandlers,
): StreamFallbackController {
    let state = initStreamFallback(urls);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const clear = (): void => {
        if (timer) clearTimeout(timer);
        timer = null;
    };
    const arm = (): void => {
        clear();
        timer = setTimeout(() => {
            timer = null;
            apply(reduceStreamFallback(state, { type: "timeout" }));
        }, timeoutMs);
    };
    function apply(step: Step): void {
        if (disposed) return;
        state = step.state;
        const action = step.action;
        switch (action.type) {
            case "try":
                arm();
                handlers.onTry(action.url);
                return;
            case "arm":
                arm();
                return;
            case "disarm":
                clear();
                return;
            case "started":
                clear();
                handlers.onStarted();
                return;
            case "fail":
                clear();
                handlers.onFail();
                return;
            case "none":
                return;
        }
    }

    return {
        start: () => apply(startStreamFallback(state)),
        handle: (event) => apply(reduceStreamFallback(state, event)),
        dispose: () => {
            disposed = true;
            clear();
        },
        getState: () => state,
    };
}
