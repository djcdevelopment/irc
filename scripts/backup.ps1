[CmdletBinding()]
param(
    [string]$DestinationRoot,
    [switch]$ExcludeSecrets
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$composeFile = Join-Path $root 'compose.yaml'
$envFile = Join-Path $root '.env'
if (-not $DestinationRoot) {
    $DestinationRoot = Join-Path $root 'backups'
}

function Assert-SafeDestination {
    param([Parameter(Mandatory)][string]$Path)
    $full = [System.IO.Path]::GetFullPath($Path)
    foreach ($activeRelative in @('data', 'config', '.secrets')) {
        $active = [System.IO.Path]::GetFullPath((Join-Path $root $activeRelative))
        if ($full.TrimEnd('\') -eq $active.TrimEnd('\') -or $full.StartsWith($active.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Backup destination cannot be inside active runtime path '$active'."
        }
    }
    return $full
}

$DestinationRoot = Assert-SafeDestination -Path $DestinationRoot
[void](New-Item -ItemType Directory -Path $DestinationRoot -Force)

$timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$archivePath = Join-Path $DestinationRoot "omen-irc-$timestamp.zip"
$manifestPath = Join-Path $DestinationRoot "omen-irc-$timestamp.manifest.json"
$checksumPath = "$archivePath.sha256"

Push-Location $root
$runningServices = @()
try {
    if (Test-Path -LiteralPath $envFile) {
        $runningServices = @(
            & docker compose --env-file $envFile -f $composeFile ps --status running --services 2>$null
        )
    }

    if ($runningServices.Count -gt 0) {
        Write-Host 'Stopping services for a consistent SQLite backup...'
        & docker compose --env-file $envFile -f $composeFile stop
        if ($LASTEXITCODE -ne 0) {
            throw 'Could not stop the Compose services cleanly.'
        }
    }

    $sources = @(
        (Join-Path $root 'compose.yaml'),
        (Join-Path $root '.env.example'),
        (Join-Path $root '.gitignore'),
        (Join-Path $root 'README.md'),
        (Join-Path $root 'config'),
        (Join-Path $root 'data'),
        (Join-Path $root 'scripts'),
        (Join-Path $root 'docs')
    )
    if (Test-Path -LiteralPath $envFile) {
        $sources += $envFile
    }
    if (-not $ExcludeSecrets -and (Test-Path -LiteralPath (Join-Path $root '.secrets'))) {
        $sources += (Join-Path $root '.secrets')
    }

    Compress-Archive -LiteralPath $sources -DestinationPath $archivePath -CompressionLevel Optimal
    $hash = Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath
    [System.IO.File]::WriteAllText($checksumPath, "$($hash.Hash.ToLowerInvariant())  $([System.IO.Path]::GetFileName($archivePath))`r`n")

    $manifest = [ordered]@{
        CreatedUtc = [DateTime]::UtcNow.ToString('o')
        Host = $env:COMPUTERNAME
        Archive = [System.IO.Path]::GetFileName($archivePath)
        Sha256 = $hash.Hash.ToLowerInvariant()
        IncludedSecrets = -not $ExcludeSecrets
        PreviouslyRunningServices = $runningServices
        ImageReferences = @(
            'ghcr.io/ergochat/ergo:v2.19.0',
            'ghcr.io/thelounge/thelounge:4.5.2'
        )
    }
    [System.IO.File]::WriteAllText(
        $manifestPath,
        ($manifest | ConvertTo-Json -Depth 4),
        (New-Object System.Text.UTF8Encoding($false))
    )

    Write-Host "Backup created: $archivePath" -ForegroundColor Green
    Write-Host "SHA-256:       $($hash.Hash.ToLowerInvariant())"
    if (-not $ExcludeSecrets) {
        Write-Warning 'This archive contains credentials and private TLS material. Store it as a secret.'
    }
} finally {
    if ($runningServices.Count -gt 0) {
        Write-Host 'Restarting services that were running before the backup...'
        & docker compose --env-file $envFile -f $composeFile up -d @runningServices
        if ($LASTEXITCODE -ne 0) {
            Write-Warning 'The backup succeeded, but one or more previously running services did not restart.'
        }
    }
    Pop-Location
}
