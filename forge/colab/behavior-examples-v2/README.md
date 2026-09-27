# English behavior stage v2

321 training and 65 validation trajectories. Replays the original 209 pilot
training rows and 25 validation rows without moving examples between splits.
Adds 112 training and 40 validation rows covering unsupported actions,
confirmation without execution, and clarification of missing inputs.

New examples are manually authored synthetic conversations. They do not claim
to execute external actions. Paraphrases and multi-turn variants of each new
task family stay in one split. Validation uses distinct action/task families,
but some response wording is shared: loss is not an independent capability test.

The 35-task comparison suite and the original reserved test are excluded.
That previously inspected suite is now a development regression suite, not a
fresh blind final benchmark. Future stages require new independent holdouts.

Reproduce with `python -m forge.colab.build_behavior_data` into a new output
directory. Validate with `forge.tool_data`. Continue from pilot adapter step 50
using `--init-adapter`, a fresh optimizer, learning rate 0.00005, accumulation 8,
100 steps, and checkpoints every 25 steps. Previous runs remain unchanged.
