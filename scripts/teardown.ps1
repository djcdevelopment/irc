[CmdletBinding()]
param(
    [switch]$Purge,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$composeFile = Join-Path $root 'compose.yaml'
$envFile = Join-Path $root '.env'

function Assert-ChildPath {
    param([Parameter(Mandatory)][string]$Path)
    $resolvedRoot = [System.IO.Path]::GetFullPath($root).TrimEnd('\')
    $resolvedPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    if (-not $resolvedPath.StartsWith($resolvedRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing destructive operation outside workspace: $resolvedPath"
    }
    if ($resolvedPath -eq $resolvedRoot) {
        throw 'Refusing destructive operation against the workspace root.'
    }
    return $resolvedPath
}

Push-Location $root
try {
    if (Test-Path -LiteralPath $envFile) {
        & docker compose --env-file $envFile -f $composeFile down --remove-orphans
    } else {
        & docker compose -f $composeFile down --remove-orphans
    }
    if ($LASTEXITCODE -ne 0) {
        throw 'Docker Compose teardown failed.'
    }
    Write-Host 'Containers and the Compose network were removed; persistent data remains.' -ForegroundColor Green

    if ($Purge) {
        if (-not $Force) {
            $answer = Read-Host 'Type DELETE-OMEN-IRC to permanently delete data, credentials, certificates, generated config, and backups'
            if ($answer -cne 'DELETE-OMEN-IRC') {
                throw 'Purge cancelled.'
            }
        }

        $targets = @(
            (Join-Path $root '.env'),
            (Join-Path $root '.secrets'),
            (Join-Path $root 'config\ergo\ircd.yaml'),
            (Join-Path $root 'data\ergo'),
            (Join-Path $root 'data\thelounge'),
            (Join-Path $root 'backups')
        )
        foreach ($target in $targets) {
            $safeTarget = Assert-ChildPath -Path $target
            if (Test-Path -LiteralPath $safeTarget) {
                Remove-Item -LiteralPath $safeTarget -Recurse -Force
            }
        }
        Write-Host 'All generated state and local backups were permanently deleted and cannot be recovered here.' -ForegroundColor Yellow
    }
} finally {
    Pop-Location
}
