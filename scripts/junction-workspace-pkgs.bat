@echo off
mklink /J ".claude\worktrees\547-unify-actions\packages\agent\node_modules" "packages\agent\node_modules"
mklink /J ".claude\worktrees\547-unify-actions\packages\conductor\node_modules" "packages\conductor\node_modules"
mklink /J ".claude\worktrees\547-unify-actions\packages\gateway\node_modules" "packages\gateway\node_modules"
mklink /J ".claude\worktrees\547-unify-actions\packages\plugin-core\node_modules" "packages\plugin-core\node_modules"
mklink /J ".claude\worktrees\547-unify-actions\packages\voice\node_modules" "packages\voice\node_modules"
mklink /J ".claude\worktrees\547-unify-actions\packages\cli\node_modules" "packages\cli\node_modules"