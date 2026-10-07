# strict-types
> Adds declare(strict_types=1) to new PHP files and from __future__ import annotations to new Python files.

**Category:** Languages & Frameworks · **Version:** 1.0.0

## What it does
When Claude creates a new `.php` file with the `Write` tool, strict-types inserts `declare(strict_types=1);` after the opening `<?php` line. When it creates a new `.py` file, it inserts `from __future__ import annotations` after the shebang, encoding line, leading comments and module docstring. Files that already have it, existing files, empty files (such as `__init__.py`) and templates (`.blade.php`) are left alone.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install strict-types@claude-mods
```

## Usage
Nothing to run. You see a toast such as `added declare(strict_types=1); to User.php`, and Claude is told the line was added, so it does not add it again. The inserted line goes where a linter would put it:

```php
<?php

declare(strict_types=1);

namespace App;
```

```python
"""Models."""

from __future__ import annotations

import os
```

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `php` | boolean | `true` | Add `declare(strict_types=1);` to new PHP files. |
| `python` | boolean | `true` | Add `from __future__ import annotations` to new Python files. Not needed on Python 3.14 and later, where annotations are lazy; turn it off there. |

## How it works
- Hooks `tool.call` for `Write`. If the file does not exist yet, it rewrites the call with `next({ ...e, content })`, so the file is created with the line already in it.
- Both inserts are plain text edits: PHP after a lone `<?php` line (a file that opens with a template or code on the tag's line is skipped), Python after the header and any `from __future__` imports.
- Limits: only new files written with `Write` are changed, never edits or existing files, and writes to another machine are not touched. It fails open: if anything throws, the file is written as Claude wrote it.
