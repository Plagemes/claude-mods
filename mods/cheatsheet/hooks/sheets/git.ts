import type { Sheet } from '../sheet'

export const git: Sheet = {
  topic: 'git',
  title: 'Git',
  aliases: [],
  summary: 'status, history, branches, remotes, undo, stash',
  markdown: `## Status and history
    git status -sb                              short status with branch and tracking info
    git log --oneline --graph --decorate --all  compact history graph of every branch
    git log -p -- <file>                        history of one file, with diffs
    git log -S "text"                           commits that added or removed that text
    git show <commit>                           one commit with its diff
    git diff                                    unstaged changes
    git diff --staged                           staged changes
    git diff <a>..<b>                           compare two refs
    git blame <file>                            who last changed each line
    git shortlog -sn                            commits per author

## Stage and commit
    git add -p                         stage hunks interactively
    git add -A                         stage everything, deletions included
    git restore --staged <file>        unstage a file, keep the changes
    git commit -m "message"            commit what is staged
    git commit --amend                 rewrite the last commit (message and staged changes)
    git commit --amend --no-edit       add staged changes to the last commit, keep its message
    git commit --fixup <commit>        record a fix for an earlier commit
    git rebase -i --autosquash <base>  fold fixup commits into their targets

## Branches
    git branch -vv                   local branches with their upstream and last commit
    git switch <branch>              change branch
    git switch -c <new> [start]      create a branch and switch to it
    git branch -m <new-name>         rename the current branch
    git branch -d <branch>           delete a merged branch (-D forces)
    git merge <branch>               merge a branch into the current one
    git merge --abort                back out of a conflicted merge
    git rebase <base>                replay your commits on top of base
    git rebase -i HEAD~3             edit, squash or reorder the last 3 commits
    git rebase --continue | --abort  carry on or give up after resolving conflicts
    git cherry-pick <commit>         apply one commit to the current branch

## Remotes
    git remote -v                      list remotes with their URLs
    git fetch --prune                  update remote refs and drop deleted ones
    git pull --rebase                  fetch, then replay your commits on top
    git push -u origin <branch>        push a new branch and set its upstream
    git push --force-with-lease        force push that refuses to overwrite work you have not seen
    git push origin --delete <branch>  delete a remote branch

## Undo
    git restore <file>         discard unstaged changes in a file
    git reset --soft HEAD~1    undo the last commit, keep changes staged
    git reset HEAD~1           undo the last commit, keep changes unstaged
    git reset --hard <commit>  throw away commits and all local changes (destructive)
    git revert <commit>        new commit that undoes an earlier one
    git reflog                 every place HEAD has been: find "lost" commits
    git clean -nd              preview untracked files a clean would delete (-fd deletes)

## Stash
    git stash push -m "message"  shelve changes (add -u to include untracked files)
    git stash list               list stashes
    git stash pop                apply the newest stash and drop it
    git stash apply stash@{1}    apply a stash and keep it
    git stash drop stash@{0}     delete a stash

## Tags and extras
    git tag -a v1.2.0 -m "message"           annotated tag
    git push origin v1.2.0                   push one tag (--tags pushes all)
    git bisect start | bad | good            binary-search the commit that broke something
    git worktree add ../dir <branch>         check out a branch in a second directory
    git grep -n "text"                       search tracked files
    git submodule update --init --recursive  fetch submodules
    git config --global user.name "Name"     set your name (and user.email)
`,
}
