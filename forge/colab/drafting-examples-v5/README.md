# Drafting stage v5

909 training / 221 validation trajectories: replay grounding v3 plus 128/32
fictional text-drafting examples. Topics are split together; wording templates
are shared, so validation loss is not a generalization benchmark.

New tasks distinguish composing text from sending or publishing it. No external
action is performed or claimed. No postponed-meeting example or any exact
51-task evaluation prompt is added. Eight additional transfer prompts were
frozen after this dataset was fixed and are not used to tune further stages.

Uses the corrected `assistant-header-split-v2` encoder. Warm start from aligned
v4 step150 into a separate run; 150 steps, rank16/alpha32, lr5e-5, batch1/accum8,
checkpoints every50. This stage does not address multilingual vocabulary.
