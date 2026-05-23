#!/usr/bin/env pwsh
# Publish a previously-created GitHub draft release and optionally push the
# same zip to the Chrome Web Store. Use after reviewing the draft created
# by the main gh-release workflow.
#
# Usage:
#   pwsh publish-release.ps1 -Version 1.5.0                              # flip GH draft to published
#   pwsh publish-release.ps1 -Version 1.5.0 -CwsPublish                  # also upload to CWS as draft
#   pwsh publish-release.ps1 -Version 1.5.0 -CwsSubmit                   # also upload + submit for review
#   pwsh publish-release.ps1 -Version 1.5.0 -CwsSubmit -Target trustedTesters

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [switch]$CwsPublish,
    [switch]$CwsSubmit,
    [ValidateSet('default', 'trustedTesters')][string]$Target = 'default'
)

$ErrorActionPreference = 'Stop'

$tag = "v$Version"

function Get-RepoRoot {
    $root = git rev-parse --show-toplevel 2>$null
    if (-not $root) { throw "Not in a git repository" }
    return $root
}
$repoRoot = Get-RepoRoot
Set-Location $repoRoot

# --- 1. Fetch current release state ---
Write-Host "Checking GitHub release $tag..." -ForegroundColor Cyan
try {
    $release = gh release view $tag --json url,tagName,isDraft,name 2>$null | ConvertFrom-Json
} catch {
    throw "GitHub release $tag not found. Create the draft first (gh release create $tag ...)."
}
if (-not $release) { throw "GitHub release $tag not found." }

# --- 2. Publish if still a draft ---
if ($release.isDraft) {
    Write-Host "Publishing GitHub release $tag..." -ForegroundColor Cyan
    $isPrerelease = $Version -match '-'
    $editArgs = @($tag, '--draft=false')
    if (-not $isPrerelease) { $editArgs += '--latest' }
    gh release edit @editArgs
    if ($LASTEXITCODE -ne 0) { throw "gh release edit failed with exit code $LASTEXITCODE" }
    $release = gh release view $tag --json url,tagName,isDraft,name | ConvertFrom-Json
    Write-Host "Published: $($release.url)" -ForegroundColor Green
} else {
    Write-Host "GitHub release $tag is already published: $($release.url)" -ForegroundColor Yellow
}

# --- 3. Optional CWS upload ---
$cwsRequested = $CwsPublish -or $CwsSubmit
if (-not $cwsRequested) {
    Write-Host ""
    Write-Host "Summary:" -ForegroundColor Green
    Write-Host "  GitHub release: $($release.url)"
    Write-Host "  Chrome Web Store: skipped (pass -CwsPublish or -CwsSubmit to upload)" -ForegroundColor Gray
    return
}

$zipPath = Join-Path $repoRoot "releases/ms-teams-downloader-v$Version.zip"
if (-not (Test-Path $zipPath)) {
    throw "Zip not found for CWS upload: $zipPath. Run scripts/package-extension.ps1 first."
}

Write-Host ""
Write-Host "Uploading to Chrome Web Store..." -ForegroundColor Cyan
$cwsScript = Join-Path $repoRoot '.claude/skills/gh-release/scripts/cws-publish.ps1'
$cwsArgs = @('-Zip', $zipPath)
if ($CwsSubmit) {
    $cwsArgs += '-Publish'
    if ($Target -ne 'default') { $cwsArgs += @('-Target', $Target) }
}

& pwsh $cwsScript @cwsArgs
$cwsExit = $LASTEXITCODE

Write-Host ""
Write-Host "Summary:" -ForegroundColor Green
Write-Host "  GitHub release: $($release.url)"
if ($cwsExit -eq 0) {
    if ($CwsSubmit) {
        Write-Host "  Chrome Web Store: submitted for review (target: $Target)"
    } else {
        Write-Host "  Chrome Web Store: uploaded as draft — review at https://chrome.google.com/webstore/devconsole/"
    }
} elseif ($cwsExit -eq 2) {
    Write-Host "  Chrome Web Store: skipped (credentials not configured; run cws-auth.ps1)" -ForegroundColor Yellow
} else {
    Write-Host "  Chrome Web Store: FAILED (exit $cwsExit)" -ForegroundColor Red
    exit $cwsExit
}
