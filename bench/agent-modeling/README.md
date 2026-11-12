# Agent modeling suite

The suite measures how well an agent models through the 67js MCP tools. It records how often the agent succeeds and
what each success costs in tool calls, tokens and time. It is the yardstick from the modeling plan: a mesh feature
earns its place only if it raises these numbers.

## Tasks

Each task in `tasks.mjs` is a prompt with sizes in metres plus machine checks. The checks look only at the object the
exported recipe builds, never at how it was built, so a recipe made of primitives and one made with mesh edits are
graded alike. `measure.mjs` measures every node's render triangles in world space and reads lint from the engine's
own mesh report:

- bounds, plus whether the object rests on the ground and is centred;
- connected parts, and lint (closed and consistently wound);
- through holes (genus, from the Euler characteristic of closed parts);
- volume;
- lines through the object: whether a line along an axis misses it (an open pane) or hits it (a bar);
- closed loops where a plane cuts the object. For example, five loops at Y = 0.1 means five posts, and two loops just
  inside a side face means a recessed panel;
- outer tips around the thin axis, such as gear teeth;
- UV texel-density stretch.

| Task | What it exercises |
| --- | --- |
| crate | Insets and extrusions (recessed panels, raised lid) |
| bolt | Primitives or extrude, exact proportions |
| window | Four through holes |
| table | Several parts that stand on the ground |
| mug | A hollow, one-piece object with a handle loop (booleans or solidify) |
| gear | A profile with 12 teeth and a bore |
| fence | Repetition (array) and rails between posts |
| bracket | Two plates and two holes |
| soap | Rounding every edge (bevel) |
| pebble | A smooth solid from a box (subdivision) |
| crate-uv | The crate with even UVs |
| desk-resize, desk-resize-plain | A 12-part desk (legs, drawers with handles, lamp, book) resized in three inspected steps, graded on contact for every attached pair and on where parts end up. Relations against absolute positions |
| kettle-resize, kettle-resize-plain | Resize a kettle body so the lid, handle and spout stay against it. The first start recipe holds `relations`, the second absolute positions; the difference in tool calls is what relations are worth |
| crate-wood | The crate with a wood material pattern, to see whether agents find `pattern` |
| arm-reach | A jointed arm whose tip moves between two points, to see whether agents find `motion.ik` |
| leg-plant | A leg that plants its foot on two points with the knee bending forward: `motion.ik` with `bendToward`, `pole` and `limits` |
| tray-drop | Recipe physics: balls dropped into a pocket cut in an authored mesh, on a fixed trimesh body, graded on resting height, contact and a repeatable seek |
| robot-reach | The CC0 robot from `tests/fixtures`: IK over its Idle clip, found through the asset catalog and hierarchy |
| dice | Rounded edges plus 21 recessed pips, in one piece (harder) |
| flange | A hollow pipe with flanges and 12 bolt holes, in one piece (harder) |
| chair | Many exact parts, with open gaps between back slats (harder) |
| chamfer-plate | Long: a plate with a chamfered top rim and six blind pockets, in one piece (chamfer edit, six cuts) |
| slotted-rail | Long: a bar with every edge chamfered and five through slots, in one piece |
| crate-revision | Long: starts from the crate recipe in the prompt; raise the lid, then drill a blind hole into the body |
| bracket-revision | Long: starts from the L bracket recipe in the prompt; lengthen the base, recentre it, move to three holes |
| workshop | Long: a whole scene, a floor slab with a table, a chair and a mug, 12 parts that rest on each other |
| robot-shot | Long: the robot with both hands placed by IK, then a side-on camera, checked from the exported recipe |

| camera-closeup, camera-orbit | Frame the statue in a close-up; a 6 second camera orbit of at least 180 degrees (`scenes.mjs`) |
| light-key-fill, light-spot-shadow | A warm sun plus a cool point fill; one shadow-casting spotlight aimed at the statue |
| look-metal, look-fog | A polished gold material; a thin cool fog with a readable exposure |
| sunset-timelapse, film-reveal | Sun direction and colour tracks over 4 s; a 6 second dolly-in reveal with an exposure fade |

`references.mjs` holds one hand-built solution per task. `tests/agent-modeling-suite.test.js` checks that every
reference passes and that broken variants fail. That keeps a wrong checker from costing an agent run.

## Running

```sh
node bench/agent-modeling/run.mjs --claude <path to claude> --model sonnet --label baseline
```

Each task gets a fresh non-interactive Claude Code session in an empty temporary folder. The session has only the
67js MCP server, its built-in file and shell tools are disabled, and it runs under a per-task budget (`--budget`, in
USD, default 3) and timeout (`--timeout`, in seconds, default 1200). The budget is an estimate the bench adds up from streamed token usage and enforces itself in `run-guard.mjs`; it is never passed to claude as `--max-budget-usd`, because Claude Code shows that cap to the model and Haiku quit when it read the remainder as spent (#962). Pick tasks with `--tasks crate,bolt`. Raw
transcripts and exported recipes go to `artifacts/agent-modeling/<run>/`. The summary, with the model ID reported by
the session, goes to `results/<run>.json`. Grade one recipe by hand with
`node bench/agent-modeling/check.mjs <task> <recipe.json>`.

`node bench/agent-modeling/regrade.mjs <run>` grades a run's saved recipes again after a checker fix.

Compare runs only when they use the same model and suite version. A single run per task is noisy, so read differences
of one or two tasks as noise.

### The agent bench

`bench.mjs` is the whole bench in one command. It runs the 28 tasks of `suite.mjs` (8 modeling, 3 revision, 3 scene,
3 look, 4 light, 3 camera, 2 animation, 2 film), k times each, on each model, through headless `claude -p` with the 67js
MCP config. It calls `run.mjs` once per model, so every run is a fresh session in its own empty temp folder with only the
67js tools, and the grader reads the exported recipe, never the transcript. Graders are the checks above plus the state
checks in `scene-checks.mjs` (camera aim and orbit, lights, materials, fog, sun and camera tracks) and the rendered-look
check, and every task has a reference solution that the tests grade. Runs use the Claude Code subscription (there is no API
key), so the summary reports tokens, calls and seconds and never dollars.

The baseline, on the current main. It is long (28 tasks, 3 runs, 3 models run one after another), so start it in the
background:

```sh
node bench/agent-modeling/bench.mjs --claude <path to claude> --models haiku,sonnet,opus --runs 3 --label baseline --backend cpu
```

It prints a table with pass@1 (average success over all runs), pass^k (share of tasks that passed on all k runs),
`any of k`, calls, input and output tokens and seconds per run, then a line per model by kind. The file
`results/bench-<label>.json` holds that summary and every run's record. `--smoke` runs the two smoke tasks once to prove the
pipeline, `--tasks a,b` picks tasks, and `--resume` (same label, models and `--runs`) continues a stopped bench.

A run that makes no scene call is classified in its record (`zeroCalls`, see `zero-calls.mjs`). `infra` causes
(`start-up-failure`, `mcp-server-failed`, `timeout`, `toolsearch-empty`: claude -p or the MCP server never got going, or
ToolSearch never showed the 67js tools) are retried once, and a run that still ends that way is marked `infra`, counted in the
`infra` column and left out of pass@1. `model` causes (`toolsearch-then-quit` after ToolSearch showed the tools, `refusal`,
`no-tool-use`) stay counted as failures and are listed under the table.

To compare a branch with the baseline, run the same command with another label on the branch, then:

```sh
node bench/agent-modeling/compare-bench.mjs bench/agent-modeling/results/bench-baseline.json bench/agent-modeling/results/bench-<branch label>.json
```

It prints the totals side by side per model and the tasks whose pass count changed, and exits with 1 when a model's pass@1
drops by more than `--tolerance` (0.05) or when infra runs pass `--infra-bound` (0.1) of a model's runs, because its pass@1
then rests on too few runs. The infra count prints next to pass@1. Use the same models, `--runs` and backend on both sides. A task that moves by one
run out of three is noise; read the totals and the tasks that moved by two runs or more.

### Several runs and several models

`--runs 3` repeats every task three times, each in a fresh session. Raw files are named `<task>-<attempt>`, each record
has an `attempt`, and the summary adds `byModel`: runs, passes, success rate, tool calls, tool errors, input and output
tokens and cost for the model and for each of its tasks. `--resume <run name> --runs 3` skips the attempts already
recorded and continues. One run file holds one model, so a second model is a second run:

```sh
node bench/agent-modeling/run.mjs --claude <path to claude> --model sonnet --runs 3 --label long
node bench/agent-modeling/run.mjs --claude <path to claude> --model haiku --runs 3 --label long
node bench/agent-modeling/aggregate.mjs bench/agent-modeling/results/<sonnet run>.json bench/agent-modeling/results/<haiku run>.json
```

`aggregate.mjs` prints one row per model and one per task. Recorded failure details have local paths replaced by
`<local path>`, and `tests/agent-suite-aggregate.test.js` fails if a results file holds one.

The six long tasks (from `chamfer-plate` on) are meant to be hard for a single `scene_create`: they need sub-element
edits (chamfers, cuts), changes to a given scene, many parts or a posed character with a camera. Their references pass
and each plausible wrong variant fails the right check (`tests/agent-modeling-suite.test.js`), but no model has run
them yet, so how hard they are is not measured.

## Look score

The checks read the exported recipe, so a task can pass and still look wrong. The look score measures what a person
sees. It is reported in each record under `look`, beside the checks, and is never merged with them into one number.

- **Cameras.** Three fixed orthographic cameras (front, side, three-quarter), placed from the task's reference recipe in
  `references.mjs` (`look-cameras.mjs`). The reference sets the framing, so a candidate that is too big, too small or
  off centre shows it in every view. Motion is sampled at time zero.
- **Silhouette score.** The candidate and the reference are rasterized from each camera (`silhouette.mjs`, plain
  JavaScript, no GPU, 256 by 256 pixels). Each view scores intersection over union; a task scores the mean in
  `look.silhouette`. 1 is the reference's own outline. `robot-reach` has no silhouette, because an imported asset needs
  its skin pose; its record says `skipped`.
- **Images.** The same cameras drawn by the engine in headless Chrome on SwiftShader, 512 by 512, saved to
  `artifacts/agent-modeling/<run>/look/` and listed in `look.images`. `run.mjs` and `regrade.mjs` write them. Reference
  images come from `node bench/agent-modeling/look.mjs --references`.
- **Vision judge.** `rubric.md` scores shape, proportions, features and surface from 0 to 3. Nothing here calls a model.
  `node bench/agent-modeling/judge.mjs prompt <run> <task>` prints the rubric, the task prompt and the candidate and
  reference image paths for each camera; give those to a vision model with no other context. Store its answer with
  `judge.mjs record <run> <task> --model <name> --scores 3,2,3,1 --note "..."`. It lands in `look.judges.<name>`, so
  scores from different judges stay apart. Judge scores are not comparable across judge models.

Score one recipe with `node bench/agent-modeling/look.mjs <task> <recipe.json> [--images <directory>]`.
`tests/agent-look-score.test.js` checks that a widened or incomplete table scores below the correct one, on silhouette
masks alone.

The results before 2026-10-31 hold no recipes (`artifacts/` is ignored by Git and was not kept), so they have no look
score and cannot be regraded. The next run records one.

## Baseline

`results/2026-10-30-07-48-sonnet-baseline.json`: `claude-sonnet-5-5`, one run per task, without the `build-67js-scene` skill, 67js 0.11.0.
10 of 10 passed with 67 tool calls and $4.76 in total. The `bracket` record comes from a rerun after its prompt was
made unambiguous about the total height; the others were graded again after three checker fixes, without new agent runs.

Read this as a cost baseline, not a success rate:

- **The pass rate is at its ceiling.** Sonnet passes every task at this difficulty, so these tasks can only show changes in
  tool calls and cost. The suite needs harder tasks before it can show that a feature helps an agent succeed.
- **Agents rarely use the edit tools.** Only 2 of 10 runs called `mesh_edit`. Most recipes use placed primitives, and
  the mesh edits they do use are written directly into `scene_create`. No run used `loop_cut`, `mirror` or `array`.

Friction seen in the transcripts, all fixed after this baseline:

- `extrude` with holes whose edges line up left T-junctions in its caps, so the mesh was open. The window run hit it
  and fell back to separate bars.
- `mesh_inspect` took only `geometries`, while `mesh_edit` takes `geometry`. Four runs sent `geometry` and got a
  validation error.
- The default box has a bevel, which surprised the fence, table and soap runs. They first got rounded shapes or wrong
  sizes. The default stays, and the tool schema now says so.

## After the three fixes

`results/2026-10-30-08-14-sonnet-after-fixes.json` reruns the five affected tasks, one run each, with the same model:

| Task | Tool calls | Tool errors | Cost (USD) |
| --- | --- | --- | --- |
| window | 10 → 4 | 1 → 0 | 0.52 → 0.43 |
| gear | 7 → 5 | 2 → 1 | 0.53 → 0.49 |
| soap | 11 → 4 | 2 → 0 | 0.55 → 0.43 |
| fence | 7 → 2 | 1 → 0 | 0.49 → 0.40 |
| table | 4 → 2 | 1 → 0 | 0.41 → 0.40 |
| Total | 39 → 17 | 7 → 1 | 2.40 → 2.15 |

All five passed both times. The window run now builds the frame with one `extrude`, the route it gave up on before. The
one remaining error is the gear run trying the disabled Bash tool. With one run per task this shows a direction, not an
exact size.

## With the skill, and harder tasks

`results/2026-10-30-11-32-sonnet-with-skill.json` runs all 13 tasks with `--skill`. The no-skill side is
`results/2026-10-30-11-43-sonnet-hard-no-skill.json` for the three harder tasks, the after-fixes run for its five tasks,
and the baseline for the other five. Same model, one run per task.

| Tasks | Passed | Tool calls | Tool errors | Cost (USD) |
| --- | --- | --- | --- | --- |
| First 10, no skill | 10/10 | 45 | 2 | 4.40 |
| First 10, with skill | 10/10 | 39 | 4 | 4.44 |
| dice, flange, chair, no skill | 3/3 | 12 | 1 | 1.40 |
| dice, flange, chair, with skill | 3/3 | 8 | 0 | 1.43 |

What this does and does not show:

- **The harder tasks did not lift the ceiling.** Sonnet passes all 13 either way, including a die with 21 recesses and a
  pipe with 12 bolt holes. A part with exact sizes is solved in a few calls, often one `scene_create`. Success on such
  tasks cannot separate one tool set from another.
- **The skill made no clear difference to cost.** The gap in calls is small enough to be noise at one run per task, and the
  cost is flat. It can change the method: with it, the crate run used insets and extrusions instead of booleans.
- **Most of the edit vocabulary went unused either way.** `mesh_edit` appeared in one of 13 runs with the skill, and
  `mesh_stack`, `loop_cut`, `mirror`, `array` and `solidify` in none. Agents write the whole recipe at once. This is about
  these tasks, which do not need those operations; it does not show the operations are useless.

The suite now finds tool friction and tracks cost, but does not measure how good an object looks. Tasks with free form,
such as organic shapes or a look to match, would need a score for appearance before they could test more.

## Default look on a cold run (2026-11-01, issue #53)

`results/2026-11-01-01-25-haiku-look-before.json` and `results/2026-11-01-01-36-haiku-look-after.json`: Haiku, six tasks, one run each, no skill, judged by a Sonnet vision judge (`sonnet-vision`, 0 to 12, against references drawn under the same defaults). The only engine change between them is the default `effects.exposure`, 1 to 0.8. The look harness was also fixed first: it drew without the setup's environment map, so its images were darker than the MCP preview. Both runs were drawn with the fix.

| Task | Judge before | Judge after | Silhouette before | Silhouette after |
| --- | --- | --- | --- | --- |
| crate | 12 | 10 | 1 | 1 |
| mug | 10 | 11 | 0.7927 | 0.934 |
| table | 11 | 10 | 0.5919 | 0.5784 |
| soap | 12 | 12 | 1 | 1 |
| chair | 12 | 12 | 1 | 1 |
| gear | 9 | 11 | 0.9475 | 0.9724 |
| Total | 66 | 66 | | |

- **No lift shown.** The totals tie, and each task moved by one or two points either way, which is judge and agent noise at one run. The done condition of #53 (a cold recipe scoring above the current default) is not met by this measure.
- **The judge cannot see a default change.** It scores shape and features against a reference drawn under the same defaults, and agents never set lights, environment, effects, shadow or bake (their tool calls set only a camera, in 4 of 6 runs, and `roughness` in one), so both sides always share the look. A look score that separates lighting needs a fixed reference drawn under the old default, or a judge question about shading.
- **What a reader sees.** The images show an object floating on a flat grey backdrop with no contact shadow, and a pale top face at exposure 1. A default ground with a contact shadow is the larger fix and was not built: a floor in every recipe would change recipes that draw their own.
- Cost: $0.75 and $0.83 for the agent runs, $0.21, $0.99 and $1.19 for the judge.

### Exposure dropped, automatic floor added

The exposure change above was reverted: on the six cold recipes no subject pixel reached 250 at exposure 1 or 0.8, and mean luma on the subject was 157, 187, 199, 194, 196 and 199 at 1 against 142, 173, 187, 182, 183 and 187 at 0.8 (crate, mug, table, soap, chair, gear), so 1 does not clip. The numbers in the table above came from the 0.8 run; treat its judge total as one more tie.

`surface-judge.mjs` asks one reference-free question per task, "does the object sit on a surface, with a believable contact shadow", 0 to 3 over the three cameras (`results/2026-11-01-surface-judge.json`, Sonnet, same six cold recipes). Before the automatic floor: 0, 0, 0, 0, 0, 0. After: crate 1, mug 1, table 2, soap 1, chair 1, gear 0. The judge's notes say the same thing each time: the three-quarter view shows a floor and a shadow, and the front and side views do not, because those cameras sit at floor height and see a floor edge-on. Gear showed no floor in any view. The fixed cameras limit this score, so read it as a direction.

### Gear sees no floor: the floor rule misread it (2026-11-01, issue #53)

Cause, measured by calling `agentGroundPlacement` on the six stored cold recipes: for `gear` it returned null. The gear is one thin part that spans its whole scene and is the lowest geometry, so the rule "a part that spans 90 percent of the scene, is thin and lowest is the recipe's own floor" took the gear for a floor, and no floor was added. The other five returned a placement at height 0. This was an engine fault, not a camera limit. Fix in `src/agent-ground.js`: a lone part never counts as a floor, so a lone flat object gets one. A room floor still counts although its walls are as wide (test). The limit that remains: a flat object with a small hub or shaft on it still reads as a plate with something on it, and gets no floor. `tests/agent-ground.test.js` covers the lone gear.

Same six cold recipes, drawn from the same fixed cameras, judged by `surface-judge.mjs` (Sonnet, `results/2026-11-01-surface-judge-gear-fix.json`, $1.12; one judge call per task, so one point is inside the noise):

| Task | No floor | Floor, first rule | Floor, gear fix |
| --- | --- | --- | --- |
| crate | 0 | 1 | 2 |
| mug | 0 | 1 | 1 |
| table | 0 | 2 | 1 |
| soap | 0 | 1 | 1 |
| chair | 0 | 1 | 1 |
| gear | 0 | 0 | 1 |
| Total | 0 | 6 | 7 |

Every note names the same gap: the three-quarter view shows a surface and a shadow, the front and side views (orthographic at floor height) show an edge-on floor and a flat grey backdrop. The cameras were not raised: the benchmark cameras are not what an agent sees in the preview, so raising them would not show that the floor reads to an agent. The gear's three-quarter view, opened by hand, shows the floor but only a faint shadow, and a floor colour close to the backdrop. Read the 0 to 6 to 7 as direction (inferred from one judge call per task), not as a measured lift of one point.

### A judge that can see a default change: blind pairwise (2026-11-01, issue #53)

`default-judge.mjs` draws the six stored cold recipes (`cold-recipes/`, copied from the Haiku run `2026-11-01-01-36-haiku-look-after`; the `environment`, `effects` and `shadow` fields are dropped because they hold only normalized defaults, so the engine's current defaults apply) under two defaults, from two cameras: the fixed three-quarter view and the recipe's own camera at 768 x 512, which is what `scene_look` draws (the preview calls `renderer.render` with `scene.camera`; the harness now does the same for a view with no camera of its own). One Sonnet call per task and repeat sees both views as "first" and "second" renders in a seeded order (repeat 0 random, repeat 1 swapped, repeat 2 random) and answers which looks more like a finished, believable render. Three repeats, 18 calls, exact two-sided binomial p against 0.5 on side B's wins. `results/2026-11-01-default-judge-*.json`.

| Comparison (A against B) | Wins A | Wins B | p |
| --- | --- | --- | --- |
| no floor against current default (floor 0.6) | 0 | 18 | 0.0000076 |
| current default against floor 0.38 | 5 | 13 | 0.096 |
| current default against floor 0.22 | 0 | 18 | 0.0000076 |
| control: no floor against itself | picked first 17, second 1 | | 0.00014 |

- **#53's done condition, measured.** The current default beats the old one in 18 of 18 calls, 9 of 9 when shown first and 9 of 9 when shown second, so position cannot explain it. The cold recipes were not changed; only the engine default differs.
- **The control shows a position bias on ties.** Shown the same image twice, the judge picks "first" 17 times in 18 and says in its notes that it is choosing arbitrarily. A tie therefore goes to "first". That does not touch the 18 of 18 above, which won from both positions, but a result close to 9 of 18 would not be informative, and 13 of 18 (the 0.38 floor) is not significant.
- **What the judge complained of.** Notes name a darker, more contrasty ground, a stronger and better-defined cast shadow, and tonal separation between object, floor and backdrop. The floor was close to the backdrop in luminance, so the shadow had nothing to read against.
- **Kept: floor colour 0.6, 0.6, 0.58 to 0.22, 0.22, 0.21** (`src/agent-ground.js`), a free default (no schema). A darker floor beats the current one 18 of 18. The other candidate, 0.38, did not clear significance. Not tried: a default-on soft occlusion (it changes every recipe, so it would move the `npm run reference` scenes that get no floor) and a lighting-level contact shadow (the floor is lit mostly by the environment map, which casts no shadow, so a stronger shadow needs a lighting change for every scene).
- **Limits.** Six objects, one agent model (Haiku), one judge model and a judge that likes contrast; the pairwise verdict says the render looks more grounded, not that it is closer to a photograph. The judge spend was above the $4 plan: $4.50 (the default 25k token system prompt of a headless session was cached on about one call in four at $0.10 each; the 0.007 dollar calls are the cached ones).

## Clip layers (2026-10-31)

`robot-walk-wave` asks for a character that walks and waves at once through `motion.layers`. The check `assetWalkAndWave` reloads the exported recipe, plays each layer alone (keeping its own speed, offset and loop) and compares part matrices at two times: the legs must match Walking and move, the right arm must leave Walking, the left arm must keep walking. Cold Sonnet, no skill, `results/2026-10-31-11-40-sonnet-walk-wave-cold-fixed-grader.json`: 1 of 1, 7 tool calls (2 errors), $0.31. A first run, with a check that compared against Walking at speed 1 only, failed on a recipe the agent had correct (it set per-layer speeds); the check was fixed and that recipe grades as a pass. One run is not a rate.

## Best of three, branches on and off (2026-11-01, issue #67)

`best-of-three` starts from a lamp and offers three shade widths (0.1, 0.18, 0.26 m). The agent keeps the one that covers the 0.08 m bulb by 0.03 m a side and fits a 0.2 m shelf; only 0.18 m does. The check on the exported recipe grades size, ground, part count and the shade's centre. The prompt does not mention branches. `run.mjs --branches off` starts the MCP server with `--branches off` (no `branch` field in any schema, no variants advice in the instructions), and each record has `branchCalls`, the calls that passed a branch name.

| Model | Branches | Pass | Calls (3 runs) | Errors | Cost | `branch` calls |
| --- | --- | --- | --- | --- | --- | --- |
| Haiku | on | 3/3 | 7, 5, 3 | 1 | $0.17 | 0 |
| Haiku | off | 3/3 | 6, 4, 7 | 1 | $0.26 | 0 |
| Sonnet | on | 3/3 | 3, 3, 3 | 0 | $0.96 | 0 |
| Sonnet | off | 3/3 | 3, 3, 3 | 0 | $0.88 | 0 |

Result: agents ignored branches in all 12 runs. Sonnet wrote the right shade in its first `scene_apply` and exported (3 calls, with or without branches). Haiku varied from 3 to 7 calls either way, with no sign of an effect. Calls did not drop, so the issue's first done condition is not met. The task is too easy to need a comparison: the goal is arithmetic on sizes the prompt states. A task where the right variant can only be told from a render, or where a wrong pick costs a long repair, is the next try. Until then branches have no measured benefit on this suite.

## Best of three, picked from a shadow (2026-11-01, issue #67)

`render-pick` starts from a gallery: a floor, a back wall, a painting on it, a pillar 1.5 m in front of the painting and one shadow-casting spotlight at [-1.8, 2.4, 1.5], aimed at the painting. The prompt offers two more places, [0, 2.4, 1.5] and [1.8, 2.4, 1.5], and asks for the one from which the whole painting is lit with no pillar shadow on it. It gives no shadow geometry and does not mention branches. The check `litPainting` reads the exported recipe and traces rays itself: exactly one spot light, at an offered place, aimed at the painting's centre (0.05 rad), a cone that reaches every corner (at most 0.9 rad), shadows on, and none of 861 points (a 41 by 21 grid, 15 points when the task was first measured) on the painting's front face is hit by a ray-to-box test against the pillar. Computed over the 15 points, the pillar hides 6 from the first place, 6 from the second and none from the third, so only the third place passes. The pillar, painting, wall and floor must stay put. `tests/agent-modeling-suite.test.js` grades the reference and each shortcut (a shadowed place, shadows off, a light off the offered places, two lights, a moved pillar). The wall and floor are not graded beyond part count.

| Model | Branches | Pass | Calls (runs) | Errors | Cost | `branch` calls | `scene_look` calls |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Haiku | on | 3/3 | 6, 5, 4 | 0 | $0.06 | 0 | 3 |
| Haiku | off | 3/3 | 5, 4, 5 | 0 | $0.06 | 0 | 3 |
| Sonnet | on | 2/2 | 3, 3 | 0 | $0.62 | 0 | 0 |
| Sonnet | off | 2/2 | 3, 3 | 0 | $0.61 | 0 | 0 |

Result (measured): all 10 runs passed and none used branches. Sonnet picked the right place in its first `scene_apply` without looking (3 calls: `scene_create`, `scene_apply`, `scene_export_recipe`, plus one `ToolSearch`), which means it traced the pillar's shadow in its head; the layout is simple enough that this works. Haiku also chose right in its first apply, then called `scene_look` once to confirm, so a render was used as a check, not as the way to choose. Calls with branches on and off are within a call of each other. The issue's condition, a suite task that picks the best of three variants in fewer calls than now, is not met: calls did not drop, and the task did not make agents fork. Together with `best-of-three` (12 runs, no branch calls), that is 22 runs on two tasks where branches earned nothing measurable. What this does not show: a scene where tracing by hand is out of reach (many occluders, a bounced light, a colour or exposure judgement) or where the first guess is wrong and costs a long repair. I did not build one, and I did not reword this task until branches won.

The other half of the issue, `npm run smoke:agent-branches` on SwiftShader: passed (fork, shared snapshot, review, labels, keep, hostile names), including the label check.

## Best of five lights, none of them clear (2026-11-03, issue #67)

`light-pick-hard` starts from a gallery with a 2 m by 1.2 m painting, six thin posts at different depths and heights, and a spotlight at the first of five offered places (x = -2.4, -1.2, 0, 1.2, 2.4 at height 2.6, depth 1.5). Every place puts some post shadow on the painting. The prompt asks for the place that leaves the least of it in shadow, and does not mention branches. The shares in shadow, over a 41 by 21 grid of the painting, are 24, 24, 37, 10 and 27 per cent, so the fourth place wins by 14 points and no place is clear. The posts were found by a random search for a layout whose best place is neither the start, the middle nor an end and wins by a wide margin. The check `litPainting` with `least: true` needs one spotlight at an offered place, aimed at the painting's centre, shadows on, a cone that reaches the painting, and a shadow share no larger than any other offered place; the posts and painting must stay put. `tests/agent-modeling-suite.test.js` grades the reference, each of the four other places and the shortcuts (shadows off, a light off the offered places, two lights, a moved post).

| Model | Branches | Pass | Calls (runs) | Errors | Cost | `branch` calls | `scene_look` calls |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Haiku | on | 3/3 | 5, 9, 9 | 0 | $0.25 | 0, 5, 6 | 1, 0, 0 (`scene_review`: 0, 1, 2) |
| Haiku | off | 3/3 | 5, 5, 4 | 0 | $0.20 | 0 | 1, 1, 1 |
| Sonnet | on | 3/3 | 3, 3, 4 | 1 | $1.04 | 0 | 0 |
| Sonnet | off | 3/3 | 3, 3, 4 | 1 | $1.04 | 0 | 0 |

Calls count tool calls except `ToolSearch`. Result (measured, 3 runs per cell): branches did not save calls. Haiku used branches in 2 of 3 runs with branches on, 5 and 6 calls each, and ended with more calls (mean 7.7) than with branches off (mean 4.7), where it rendered one view with `scene_look` and picked. Both settings passed 3/3. Sonnet again used no branches and no render: 3 calls (create, apply, export) in two runs and 4 in the third (one `Bash` call) with branches on or off, and all 6 runs picked the best place. Sonnet's runs spent about 3,700 to 4,500 output tokens against Haiku's 10,000 to 15,000, so it worked the answer out before its first apply; the transcripts do not say how. This task is harder to trace than `render-pick` (the shares are 10 to 37 per cent from six posts), yet Sonnet still solved it with no look, so a trace this long is not out of its reach. The issue's calls condition is not met: no model made fewer calls with branches, and Haiku made more. I did not change the task after the runs. What this does not show: a judgement a model cannot compute (colour, exposure, composition) where the best of several variants shows only in a render, which needs a check that renders instead of tracing rays.

## A walk around two holes and a rock (2026-11-01, issue #64)

`terrain-path-walk` builds 40 m of hills with two round openings (radius 3 m at the origin, 2.5 m at [9, 9]) and a 3 m by 2 m by 3 m `rock` at [-8, -8], then walks a `walker` node from [-15, -15] to [15, 15] in 10 s. The check on the exported recipe samples 41 times: the position stays within 1.5 m of the ground height, at least 0.3 m outside both openings and at least 0.3 m from the rock's footprint, and starts and ends within 0.75 m of the two points. The `through` check confirms both openings are cut clean through. The robot GLB cannot stand on a recipe terrain (asset scenes hold no recipe geometry), so the character is a box node, like `terrain-hole-walk`. The prompt does not mention the path query: agents find it in the `scene_inspect` schema (`path`) and in `scene_capabilities` `navigation`. `pathQueries` in each record counts `scene_inspect` calls that passed `path`.

| Model | Runs | Pass | Calls | Errors | Cost | `path` queries |
| --- | --- | --- | --- | --- | --- | --- |
| Haiku | 2 | 2/2 | 12, 13 | 2, 2 | $0.15 | 2, 3 |
| Sonnet | 1 | 1/1 | 9 | 0 | $0.40 | 3 |

Result: all three agents used the query and wrote its keyframes into a `LINEAR` walker track (29 or 30 keys with the query's three-decimal values, not a hand-drawn polyline). The four Haiku errors were unrelated schema slips (`sessionId` on `scene_create`, motion keys at the recipe top level, a node with a geometry and no material), not path errors. Nothing here shows what the query saves: the task was not run with the query hidden, and an earlier task with one hole (`terrain-hole-walk`) was walked by hand 2 of 2 times by Haiku. Three runs is too few to separate Haiku from Sonnet. Total cost $0.55, one run each of the three.

## Editing a cabinet, relations on and off (2026-11-02, issue #44)

Issue #44 left one done condition open: tool calls do not drop on suite tasks with attached parts, because agents building from scratch compute positions themselves. The hypothesis here was that relations pay off when an agent edits a scene that already has them. `cabinet-resize` starts from a 10-part cabinet (body, four feet, two doors, two handles, a cornice) and asks for 30 percent wider (1.0 to 1.3 m) and 10 cm taller; `cabinet-resize-plain` holds the same parts as absolute positions. `desk-resize` and `desk-resize-plain` are the existing 12-part, three-step desk. Both are graded on contact (`touches`) and on every dependent part's final centre (`centreAt`). `--relations off` starts the MCP server without the relations field in `scene_create` and `scene_apply` and without the relations entry in `scene_capabilities`; records carry `relationCalls`.

Three arms, 3 runs per task, budget $1 per run, 0 tool errors unless noted. Calls are per run:

| Model | Start recipe | Relations in tools | cabinet pass | cabinet calls | desk pass | desk calls |
|---|---|---|---|---|---|---|
| Haiku | relations | on | 3/3 | 5, 7, 6 | 3/3 | 10, 9, 10 |
| Haiku | plain | on | 1/3 | 5, 6, 5 (1 error) | 3/3 | 10, 9, 10 |
| Haiku | plain | off | 1/3 | 6, 4, 5 | 3/3 | 10, 10, 12 |
| Sonnet | relations | on | 3/3 | 3, 3, 3 | 3/3 | 8, 8, 8 |
| Sonnet | plain | on | 3/3 | 3, 3, 3 | 3/3 | 8, 8, 8 |
| Sonnet | plain | off | 3/3 | 3, 3, 3 | 3/3 | 8, 10, 8 |

Result (measured): tool calls do not drop. Sonnet needs 3 calls on the cabinet (create, one `scene_apply`, export) and 8 on the desk (the prompt asks for an inspect after each of three steps) in every arm. Haiku's means are 6.0 against 5.3 and 5.0 on the cabinet and 9.7 against 9.7 and 10.7 on the desk, inside the noise at 3 runs. With relations on and a plain start, no run wrote a relations field (0 of 12), so agents do not add them on their own. The relations-start arms show 3 of 3 for `relationCalls` only because `scene_create` carries the recipe the task hands over.

What did move is Haiku's pass rate on the cabinet: 3/3 with relations in the start recipe, 1/3 in both plain arms. The plain failures are the handles (0.01 m off their centre in three runs) and, once, the feet (12 of 21 checks). It is 3 runs, so treat it as a lead, not a result. The condition "tool calls drop on suite tasks with attached parts" stays unmet; Sonnet recomputes a 10 to 12 part scene in one call either way.

## Look pick, a pick only the picture decides (2026-11-03, issue #67)

`look-pick` starts from a still life (floor, wall, a slab with a jug, a loaf and a cloth, a low warm sun) graded with "dusk" in `effects`. The prompt offers two more grades, "golden" and "airy", all `exposure`, `contrast` and `temperature` numbers, and asks for the one whose picture reads as a warm late-afternoon photograph in mid-tones, neither dim and heavy nor pale and washed out. Only the effects block may change. The check `renderedLook` does not trace anything: it draws the exported recipe from its own camera in headless Chrome on SwiftShader (`look.mjs` `measureRenderedLook`) and reads the pixels: mean brightness 0.30 to 0.46, at most 1 per cent clipped and 2 per cent crushed pixels. Measured: dusk 0.25 (too dim), golden 0.35 (passes), airy 0.52 (too pale). Brightness is not a function of the typed numbers that can be worked out by hand (exposure, contrast and the tone curve interact), and the window was fixed before any agent ran. `tests/agent-modeling-suite.test.js` grades the reference, the dim and pale grades, a too-bright key light and a moved loaf.

| Model | Branches | Pass | Calls (runs) | Errors | `branch` calls |
| --- | --- | --- | --- | --- | --- |
| Haiku | on | 3/3 | 9, 9, 9 | 0 | 0 |
| Haiku | off | 3/3 | 9, 10, 9 | 0 | 0 |
| Sonnet | on | 0/3 | 7, 7, 7 | 1 each | 5, 4, 5 |
| Sonnet | off | 0/3 | 8, 7, 8 | 0 | 0 |

Result (measured, 3 runs per cell): branches did not save calls where the task was passed. Haiku made 9 calls in five of six runs with no branch call, and passed with branches on and off. Sonnet used branches in all 3 runs with them on (4 to 5 calls) and finished in 7 calls against 7 to 8 without, but it failed all 6 runs: every run kept "airy", which measures 0.52 (too pale). A one-call lower count for runs that all fail is not a saving. The issue's calls condition is not met. What this shows: the check rejects the plausible wrong pick and Sonnet makes it, so the look judgement is the hard part here, and branches that render the three variants side by side did not lead Sonnet to the right one. What it does not show: whether a different brightness window or a prompt that gives a target picture would change either model's pick. The task was not changed after the runs.

## An overshoot with one easing (2026-11-03, issue #286)

`overshoot-lift` asks for a 0.4 m block that rises from 0.2 m to 1.2 m in 1 s, peaks between 1.25 m and 1.45 m and settles on 1.2 m. The `overshoot` check samples the exported recipe 41 times: the start and end heights within 0.02 m, a peak in the range, and a settle after the peak. The reference uses `easeOutBack` on a `LINEAR` track: 2 keyframes. `EASING_PLAIN_SOLUTION` does the same with plain `SMOOTH` keyframes and needs 3, because the peak and the settle have to be placed by hand (its peak at t = 0.55 and 1.32 m came from trying values until the check passed, which an agent would also need a retry to do). Both pass the check and a recipe without the easing fails it (`tests/agent-modeling-suite.test.js`). Live runs are in the next section.

### Live runs of the overshoot pair (2026-11-03, issue #286)

`overshoot-lift-plain` is the same task with one added clause: use only plain keyframes and no `easing` field. The prompt of `overshoot-lift` does not mention easings, so the agent finds them or not in the tool schema. Three runs each, Sonnet through Claude Code on a subscription (no API key), CPU backend, budget $1 per run: `node bench/agent-modeling/run.mjs --claude <claude executable> --model sonnet --tasks overshoot-lift,overshoot-lift-plain --runs 3 --backend cpu --label overshoot`. The harness already drove Claude Code headless, so no new driver was needed. `--backend cpu|gpu` is new and defaults to `gpu`. Results: `results/2026-11-03-17-23-sonnet-overshoot.json`.

| Task | Pass | Tool calls (runs) | Turns | Time | Keyframes (runs) | Easing used |
| --- | --- | --- | --- | --- | --- | --- |
| overshoot-lift | 3/3 | 2, 2, 2 | 4, 4, 4 | 22 to 23 s | 6, 6, 6 | 0 of 3 |
| overshoot-lift-plain | 3/3 | 2, 2, 2 | 4, 4, 4 | 22 to 24 s | 4, 5, 5 | not allowed |

Tool calls exclude `ToolSearch`. Each run was `scene_create` with the motion inside it and one `scene_export_recipe`, with no errors and no retry.

Result (measured, 3 runs per task): the call count is the same with and without the easing, because Sonnet never used one. In the free arm all 3 runs wrote 6 plain keyframes on a `LINEAR` track with the peak at 1.35 m and passed on the first try. The 2-keyframe `easeOutBack` version in the reference was not found or not chosen. So the issue's condition is met as a comparison, and the answer is no difference in calls, 2 against 2. It does not show that the easing saves calls when an agent is told to use it, and the plain arm needed no retry, unlike the hand search that placed the reference peak. Not measured: Haiku, a prompt that names easings, or a harder curve.

## Other clients and models (2026-11-04, issue #69)

`results/2026-11-04-clients-models.json`. Claude Code runs used the 5-task sample `crate,bolt,window,table,mug`, 2 runs each, on the CPU backend, with `--model haiku` and `--model sonnet`. Pass rate and means are per run.

| Client and model | Task | Pass | Mean tool calls | Mean turns |
| --- | --- | --- | --- | --- |
| MCP Inspector CLI 2.13.0 | `tools/list`, `scene_create` | pass, 22 tools | | |
| MCP Python SDK 2.3.0 | `initialize`, `tools/list`, `scene_create`, `scene_look` | pass, 20480 byte PNG | | |
| Claude Code, haiku | all five MCP tasks | 10 of 10 | 7.0 | 9.0 |
| Claude Code, sonnet | all five MCP tasks | 9 of 10 | 3.2 | 5.3 |
| Claude Code, haiku | `llms.txt` and the package, no MCP | 2 of 2 | 14.0 | 15.0 |
| Claude Code, sonnet | `llms.txt` and the package, no MCP | 2 of 2 | 10.5 | 11.5 |

By task (pass of 2, mean tool calls):

| Task | haiku | sonnet |
| --- | --- | --- |
| crate | 2, 6.5 | 1, 2.0 |
| bolt | 2, 11.0 | 2, 2.0 |
| window | 2, 6.0 | 2, 3.5 |
| table | 2, 5.5 | 2, 2.0 |
| mug | 2, 6.0 | 2, 6.5 |

- Haiku passed everything but needed about twice the tool calls. Sonnet used fewer calls and failed one `crate` run: it wrote a single `inset_region` over four faces in 2 calls, never inspected the mesh, and got one loop per panel instead of two. That is a model shortcut, not a schema defect, and one failure in ten is within the noise of this sample.
- The no-MCP task is `llms-only.mjs`: a fresh folder with the package installed from a packed archive and a copy of `llms.txt`, no web access, no MCP. The agent writes a script that renders a red sphere on a ground plane to `scene.png`; `png-check.mjs` requires a real 512 px PNG with many colours. Both models pass.
- Friction found: in both sonnet runs the first `cd node_modules/67js` failed, because the guide's script assumes the `67js` alias install and the task installed `@codepawlhq/67js` plainly. Fixed in `docs/guide.md` and `public/llms.txt`, which now state both install names. These two sonnet runs predate that fix.
- The Inspector CLI starts a new server per command, so it cannot show a preview image; that is the client, not the server.
- Every page that `llms.txt` and the README link to is checked against the package and the site by `tests/other-clients.test.js`.

Not run:

| Client | Reason |
| --- | --- |
| Non-Anthropic models | None is free here: a hosted model needs an API key and spend, and a local LLM is deliberately not installed |
| Cursor | Interactive desktop client with its own account; no headless mode to drive |
| Gemini CLI | Needs a Google sign-in or API key, which this setup does not have |
| VS Code | Interactive client behind a Copilot subscription that is not set up here |
| Claude Desktop | A GUI app that cannot be driven without computer use |

### Antigravity CLI (2026-11-07)

`llms-only.mjs --agent agy --agy <agy executable> --model <model>` drives the Antigravity CLI, which offers Gemini 4 Argon, Gemini 3.8 Flash and GPT-OSS 120B. Headless mode denies every shell command, so the runner passes a session-only settings file (`--settings`, never saved) with one rule, `permissions.allow: ["command(*)"]`, and removes it after the run. The CLI cannot switch its web tools off, so the runner records any web tool call as `usedWeb` and fails it. Run `npm run build:lib` first: the pack skips scripts, and the runner stops when `build/` is missing. With 2 attempts per model (`results/2026-11-07-agy.json`): Gemini 4 Argon 2 of 2, Gemini 3.8 Flash 2 of 2, GPT-OSS 120B 0 of 2 (it searched the web in every attempt despite the prompt, then timed out waiting for the page). One Gemini 4 Argon PNG was 768 px, which the check accepts because it requires a minimum side only. The MCP suite is not run through this CLI: `agy` reads MCP servers only from its global config, and `--settings` rejects `mcpServers`.

## Agent friendliness: 67js MCP against three.js by code (2026-11-07, issue #31)

The three.js half of issue #31 and the 67js side of the same table. The Blender MCP half is in the next section. Model `sonnet`, headless `claude -p` on the subscription, 6 suite tasks (`crate`, `bolt`, `window`, `table`, `fence`, `bracket`), 1 run each per system, so 12 records in `results/2026-11-07-threejs-vs-67js.json`. Tokens and tool calls are reported; there is no API dollar figure.

- 67js MCP: `run.mjs`, the task prompt behind the usual MCP preamble.
- three.js: `threejs.mjs`, the same task text behind a different preamble. The agent gets an empty folder with `three` installed from npm, Bash, Read, Write, Edit, Glob and Grep, no web and no MCP. It writes `build.mjs`, which builds the object, writes `geometry.json` (world-space triangles per mesh) and renders `scene.png` with headless Chrome on SwiftShader.
- Same grading: the task's own checks run on `geometry.json` (corners welded before the closed-surface, hole and loop counts; the grader passes the suite's reference geometry of all six tasks, see `tests/agent-threejs-grade.test.js`), and the look score is the suite's silhouette overlap from the three fixed cameras. A three.js run passes when every check passes and `scene.png` is a real picture.

| System | Pass | Mean tool calls | Mean tokens (in+out) | Mean look | Mean wall seconds |
| --- | --- | --- | --- | --- | --- |
| 67js MCP | 6/6 | 3.2 | 375k | 0.932 | 24 |
| three.js by code | 5/6 | 8.8 | 269k | 0.926 | 359 |
| Blender MCP (official server) | 6/6 | 3.8 | 177k | 0.926 | 517 |

| Task | System | Pass | Tool calls (errors) | Look | Failure |
| --- | --- | --- | --- | --- | --- |
| crate | 67js MCP | yes | 4 (0) | 1.000 | |
| crate | three.js | yes | 9 (1) | 1.000 | |
| bolt | 67js MCP | yes | 2 (0) | 1.000 | |
| bolt | three.js | yes | 7 (3) | 0.964 | |
| window | 67js MCP | yes | 4 (0) | 1.000 | |
| window | three.js | no, 4/5 | 11 (0) | 1.000 | closed-surface check: the frame has open or doubled edges |
| table | 67js MCP | yes | 2 (0) | 0.592 | |
| table | three.js | yes | 8 (1) | 0.592 | |
| fence | 67js MCP | yes | 2 (0) | 1.000 | |
| fence | three.js | yes | 11 (1) | 1.000 | |
| bracket | 67js MCP | yes | 5 (0) | 1.000 | |
| bracket | three.js | yes | 7 (0) | 1.000 | |

- Measured: 67js needed about a third of the tool calls and finished in about 24 s against about 6 minutes, most of the three.js time going to getting headless Chrome to write a PNG. Both systems built the same shapes: the look means are within noise, and `table` scores 0.592 for both, which points at the task's reference rather than at either system.
- Tokens are not lower for 67js: inferred: the MCP tool schemas and server instructions are re-read on every call, so its input tokens are higher even with fewer calls. The three.js `table` run reports only 44k input tokens although it ran 871 s, so treat that one count as unreliable.
- 67js failures: none in the checks. One harness fault: the `bracket` look images failed because the look page could not fetch the boolean wasm (`both async and sync fetching of the wasm failed`), which threw away the whole look record, silhouette included. The silhouette was scored again afterwards from the exported recipe, and the record carries `imagesError`. `scoreLook` should score the silhouette before it renders images.
- A first attempt of the 67js run failed on every task because the checkout had no `build/mcp` folder (`npm run build:lib` creates it); those results were discarded. The first three.js run stopped after `bolt` when its process disappeared, so `window`, `table`, `fence` and `bracket` were run again as a second run and joined with `compare-threejs.mjs`.
- Limits: 1 run per cell, one model, tasks the 67js suite was built around (they favour 67js's checks, not three.js). The `window` three.js failure label came from an earlier wording of the same check.

### Blind pairwise look judge (2026-11-13, issue #987)

The silhouette look score does not say which render a person or a vision model prefers. `pairwise-judge.mjs` shows the render of system A and the render of system B for one task as "first" and "second", in a seeded random order (`default-judge.mjs`'s `firstSideOf`; the repeats of one task swap sides), and asks which is the better finished render. It records the winner per task and attempt, then wins per system and an exact two-sided binomial p against 0.5. A control shows system A's own render on both sides: any preference for "first" or "second" is position bias, and a pairwise result no larger than the control's is not a preference for a system. Calls go through headless `claude -p` on the subscription, one per task, attempt and pairing.

```sh
node bench/agent-modeling/pairwise-judge.mjs --name <result name> --model sonnet --tasks crate,bolt,window,table,fence,bracket --attempts 1 \
  --a "67js MCP=artifacts/agent-modeling/<67js run>/look/{attempt}/{task}-three-quarter.png" \
  --b "three.js by code=artifacts/agent-modeling/<three.js run>/{task}-{attempt}.png"
node bench/agent-modeling/compare-threejs.mjs <67js run json> <three.js run json> <output json> --pairwise bench/agent-modeling/results/<result name>.json
```

Each side is `label=image pattern` with `{task}` and `{attempt}` filled in. `--control-only` skips the pairing and runs only the control on side A; `--seed` changes the order. The judge writes `results/<result name>.json` (summary and one record per call, with the note the judge gave), and `compare-threejs.mjs --pairwise` prints wins per system, the p and the control next to the usual tables. Run records also carry `fixRounds`, next to `toolCalls` and `toolErrors`: the number of write steps after the first render (`scene_apply` or `scene_create_asset` after the first `scene_look` or render for 67js; `Write` or `Edit` after the first `node` run for three.js). A run that renders once has 0. Records from before this change have none and print `-`.

Run on 2026-11-13 (measured): the raw renders of the 2026-11-07 head-to-head run are no longer on disk (only the scene numbers are in the result file), so the pairing was not re-run. The control ran on the 67js three-quarter renders that exist (`crate`, `bolt`, `table`, `chair`, `gear`, three attempts each, Sonnet, 15 calls, $1.76): the judge picked "first" 7 times and "second" 8 times, p = 1.0, so no position bias at this size. `results/2026-11-13-pairwise-control-67js.json`. The next three.js run saves `scene.png` in `artifacts/agent-modeling/<run>/`, which is what the `--b` pattern above reads.

### Blender MCP half (2026-11-07, issue #31)

The official Blender MCP server (Blender Lab, v1.0.3, add-on and server) driving Blender 5.1.2, same model, same six tasks, 1 run each, in `results/2026-11-07-blender-mcp.json`. The server runs model-written Python with no guards, so `blender.mjs` never runs it on the benchmark machine: Blender (headless, `--command blender_mcp`) and the HTTP MCP server run inside a throwaway Docker container (`blender-container/`, x86_64 under Rosetta on an Apple silicon laptop, one scratch folder mounted, a fresh container per task). `claude -p` reaches the server through an SSH port forward and gets only the MCP tools: no Bash and no file tools on its own machine. The prompt asks the agent to leave `geometry.json` (world-space triangles, Y up) and `scene.png` in the container's `/work`; the script copies them back and grades them exactly like the three.js run.

| Task | Pass | Tool calls (errors) | Tokens in / out | Look | Wall seconds |
| --- | --- | --- | --- | --- | --- |
| crate | yes, 8/8 | 4 (1) | 179k / 3k | 1.000 | 590 |
| bolt | yes, 7/7 | 4 (1) | 179k / 3k | 0.964 | 609 |
| window | yes, 5/5 | 4 (1) | 181k / 4k | 1.000 | 611 |
| table | yes, 6/6 | 5 (1) | 207k / 3k | 0.592 | 625 |
| fence | yes, 6/6 | 2 (0) | 116k / 3k | 1.000 | 38 |
| bracket | yes, 6/6 | 4 (1) | 182k / 4k | 1.000 | 626 |

- Measured: no failures. Tool calls exclude the `ToolSearch` call that loads the one tool the agent uses (`execute_blender_code`), as in the other runs. Look matches the other two systems (`table` 0.592 again, so it is the reference).
- Wall time is not a fair figure. Measured in the transcripts: `crate` hit Claude Code's 300 s no-response abort on its render call while the files were still written; the other four runs with an error and about 600 s show the same wall time. Inferred: the render is a CPU Cycles render of an x86 Blender under emulation, which a native Blender would finish much faster; `fence`, whose render stayed under the limit, took 38 s. Treat the 517 s mean as environment cost, not as Blender MCP latency.
- Every run but `fence` spent one call on a failed first attempt (a Python traceback or the timeout) and then repaired it. The tool takes raw `bpy` code, so the agent writes the mesh code, the Z-up to Y-up conversion and the export itself, as in the three.js run; unlike three.js it needs no browser for the picture.
- Limits: 1 run per cell, one model, tasks built around 67js. The server's own screenshot and render tools were never used; the agents rendered from their own code. The container has outbound network access (the model's code could reach the internet); only the scratch folder is shared with the host.
