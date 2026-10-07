# terraform-plan-pane
> Shows terraform plan as a clear pane of resources to create, change and destroy.

**Category:** DevOps & Cloud · **Version:** 1.0.0

## What it does
Whenever Claude runs `terraform plan` or `tofu plan`, this mod reads the plan and sums it up in the status line. `/tfplan` opens a pane with every resource grouped by what happens to it. Destroys and replacements are listed first, in red, with the reason the plan gives (`forces replacement: ami`, `not in configuration`). If anything will be destroyed, a toast warns you, and Claude gets a note to tell you before anything is applied.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install terraform-plan-pane@claude-mods
```

## Usage
- Status line after each plan: `⚠ tf plan: +2 ~1 ±1 -1 · /tfplan`, `✓ tf plan: no changes` or `✗ tf plan failed · /tfplan`.
- Toast when resources will be destroyed or replaced: `terraform plan destroys aws_s3_bucket.logs and replaces aws_instance.web. /tfplan`.
- `/tfplan` opens the pane:
  ```
  -1 to destroy  ±1 to replace  ~1 to update  +2 to create
  $ cd infra && terraform plan -out=tf.plan · /repo/infra · read from the saved plan file

  Destroy (1)
   - aws_s3_bucket.logs (not in configuration)
  Replace (1)
   ± aws_instance.web (forces replacement: ami)
  Update in place (1)
   ~ aws_security_group.web
  Create (2)
   + module.vpc.aws_subnet.private["a"]
   + aws_iam_role.ci
  ```
  It also lists imports, moves and data reads. **Ask Claude to review** (`a`, shown when something is destroyed or replaced) asks Claude to explain each destroy and replace, and how to avoid any that weren't intended, without applying anything.

## Configuration
No configuration needed.

## How it works
- A `tool.call` hook on Bash finds `terraform plan` / `tofu plan` in the command, including after `cd dir &&` and with `-chdir=dir`. Once the command has run, it parses the plan's text output: the `# address will be …` headers, the `# forces replacement` attributes and the `Plan: …` summary.
- When the plan was saved with `-out=<file>`, it then runs `terraform show -json <file>` in the background (60 s timeout) and switches to its exact `resource_changes`: replace paths, action reasons, imports and moves.
- When something is destroyed or replaced, the Bash result gets one line of context for Claude.
- Limits:
  - Plans run through wrappers (`make plan`, scripts) aren't recognised.
  - Without `-out`, a very long output that was cut shows fewer resources. The pane says so when the plan's summary counts more than it listed.
- Commands are read with the shared shell reader, so wrappers (`sudo`, `env`, `time`, `NAME=value`) and `bash -c "…"` scripts that run a plan are recognised too. With [mods-hub](../mods-hub) installed the mod says hello and: publishes `deploy.started` once per plan that has changes and did not fail (target `terraform:<folder>` or `tofu:<folder>`, environment `production`, `staging`, `development` or `test` when the folder's path names one, else `unspecified`), because an apply may follow (prod-guard and guardian read it; a plan is the closest thing to a deploy starting that this mod sees: it never applies); and sends the destroy/replace warning as a warning notice through the hub (a toast, and your phone channel while you are away). Clean and failed plans publish nothing. Without the hub the warning is the toast above.
