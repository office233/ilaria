from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Mapping

from .handlers import build_default_handlers
from .models import AiJob


AiHandler = Callable[[AiJob], Mapping[str, Any]]


@dataclass(frozen=True)
class AiProcessResult:
    ok: bool
    message: str
    outputs: Mapping[str, Any] = field(default_factory=dict)


class AiProcessor:
    def __init__(self, handlers: Mapping[str, AiHandler] | None = None) -> None:
        self.handlers = build_default_handlers() if handlers is None else dict(handlers)

    def process(self, job: AiJob) -> AiProcessResult:
        outputs: dict[str, Any] = {}
        for task in job.tasks:
            handler = self.handlers.get(task)
            if handler is None:
                return AiProcessResult(
                    ok=False,
                    message=f"Unsupported AI task: {task}",
                    outputs=outputs,
                )
            outputs[task] = dict(handler(job))

        return AiProcessResult(ok=True, message="processed", outputs=outputs)
