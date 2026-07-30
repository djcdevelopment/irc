[CmdletBinding()]
param(
    [string]$TailscaleIP,
    [string]$TailscaleHostname,
    [ValidatePattern('^[A-Za-z0-9]+$')]
    [string]$NetworkName = 'OmenPrivateIRC',
    [ValidatePattern('^[A-Za-z][A-Za-z0-9_-]{1,30}$')]
    [string]$AdminAccount = 'admin',
    [switch]$SkipPersistenceTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script:ComposeFile = Join-Path $script:Root 'compose.yaml'
$script:EnvFile = Join-Path $script:Root '.env'
$script:SecretsFile = Join-Path $script:Root '.secrets\bootstrap.json'
$script:ErgoImage = 'ghcr.io/ergochat/ergo:v2.19.0'
$script:LoungeImage = 'ghcr.io/thelounge/thelounge:4.5.2'

function Write-Step {
    param([string]$Message)
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Invoke-Docker {
    param(
        [Parameter(Mandatory)]
        [string[]]$Arguments,
        [switch]$Capture
    )

    if ($Capture) {
        $output = & docker @Arguments 2>&1
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) {
            throw "docker $($Arguments -join ' ') failed:`n$($output -join "`n")"
        }
        return ($output -join "`n")
    }

    & docker @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "docker $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

function Test-DockerEngine {
    & docker info --format '{{.ServerVersion}}' *> $null
    return ($LASTEXITCODE -eq 0)
}

function Start-DockerEngineIfNeeded {
    if (Test-DockerEngine) {
        return
    }

    $desktopPath = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (-not (Test-Path -LiteralPath $desktopPath)) {
        throw 'Docker Desktop is installed but the Docker engine is unavailable. Start the Linux container engine and rerun bootstrap.'
    }

    Write-Host 'Docker Desktop engine is stopped; starting it now.'
    if (-not (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue)) {
        Start-Process -FilePath $desktopPath -WindowStyle Hidden
    }

    $deadline = [DateTime]::UtcNow.AddMinutes(3)
    while ([DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Seconds 3
        if (Test-DockerEngine) {
            return
        }
    }

    throw 'Docker Desktop did not become ready within three minutes.'
}

function Test-TailscaleIPv4 {
    param([Parameter(Mandatory)][string]$Address)
    try {
        $ip = [System.Net.IPAddress]::Parse($Address)
    } catch {
        return $false
    }
    $bytes = $ip.GetAddressBytes()
    return ($bytes.Length -eq 4 -and $bytes[0] -eq 100 -and $bytes[1] -ge 64 -and $bytes[1] -le 127)
}

function Test-TcpEndpoint {
    param(
        [Parameter(Mandatory)][string]$Address,
        [Parameter(Mandatory)][int]$Port,
        [int]$TimeoutMilliseconds = 1500
    )
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $pending = $client.BeginConnect($Address, $Port, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne($TimeoutMilliseconds, $false)) {
            return $false
        }
        $client.EndConnect($pending)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Test-RemoteTailnetPort {
    param(
        [string]$ProbeHost,
        [Parameter(Mandatory)][int]$Port
    )
    if (-not $ProbeHost -or -not (Get-Command ssh -ErrorAction SilentlyContinue)) {
        return $false
    }
    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & ssh -o BatchMode=yes -o ConnectTimeout=5 -o UserKnownHostsFile=NUL -o StrictHostKeyChecking=no -o LogLevel=ERROR $ProbeHost "nc -z -w 5 $TailscaleIP $Port" *> $null
        $sshExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    return ($sshExitCode -eq 0)
}

function Assert-FirewallFallbackSafe {
    $policy = (& netsh advfirewall show allprofiles firewallpolicy 2>&1) -join "`n"
    if ($LASTEXITCODE -ne 0 -or $policy -notmatch 'BlockInbound,AllowOutbound') {
        throw 'Wildcard Docker binding requires Windows Firewall with BlockInbound enabled on every profile.'
    }
    $tailscaleProfile = Get-NetConnectionProfile -InterfaceAlias 'Tailscale' -ErrorAction Stop
    if ($tailscaleProfile.NetworkCategory -notin @('Private', 'DomainAuthenticated')) {
        throw "Wildcard Docker binding requires the Tailscale interface to use a Private or Domain profile; current category is $($tailscaleProfile.NetworkCategory)."
    }
    $tailRule = Get-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -ErrorAction Stop |
        Where-Object {
            $address = $_ | Get-NetFirewallAddressFilter -ErrorAction SilentlyContinue
            $address.LocalAddress -contains $TailscaleIP
        } |
        Select-Object -First 1
    if (-not $tailRule) {
        throw "Wildcard Docker binding requires an enabled inbound allow rule scoped to local Tailscale address $TailscaleIP."
    }
}

function Get-TailscaleIdentity {
    if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
        if (-not $TailscaleIP -or -not $TailscaleHostname) {
            throw 'tailscale.exe is not on PATH. Supply both -TailscaleIP and -TailscaleHostname.'
        }
        return [pscustomobject]@{
            IP = $TailscaleIP
            Hostname = $TailscaleHostname
            ProbeHost = ''
        }
    }

    $statusText = & tailscale status --json 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw 'Tailscale is installed but status could not be read.'
    }
    $status = $statusText | ConvertFrom-Json
    if ($status.BackendState -ne 'Running') {
        throw "Tailscale backend is not running (state: $($status.BackendState))."
    }

    $detectedIP = $TailscaleIP
    $detectedHostname = $TailscaleHostname
    if (-not $detectedIP) {
        $detectedIP = @($status.Self.TailscaleIPs | Where-Object { $_ -notmatch ':' })[0]
    }
    if (-not $detectedHostname) {
        $detectedHostname = ([string]$status.Self.DNSName).TrimEnd('.')
    }
    $probeHost = [string](
        $status.Peer.PSObject.Properties |
            ForEach-Object { $_.Value } |
            Where-Object { $_.Online -and $_.OS -eq 'linux' -and $_.DNSName } |
            Select-Object -ExpandProperty DNSName -First 1
    )
    return [pscustomobject]@{
        IP = $detectedIP
        Hostname = $detectedHostname
        ProbeHost = $probeHost.TrimEnd('.')
    }
}

function New-StrongSecret {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    } finally {
        $rng.Dispose()
    }
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Content
    )
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Protect-SecretFile {
    param([Parameter(Mandatory)][string]$Path)
    if ($env:OS -ne 'Windows_NT') {
        return
    }
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $Path '/inheritance:r' "/grant:r" "${identity}:(R,W)" *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Could not restrict ACLs on $Path; restrict it manually."
    }
}

function Get-OrCreateSecrets {
    $secretDirectory = Split-Path -Parent $script:SecretsFile
    [void](New-Item -ItemType Directory -Path $secretDirectory -Force)

    if (Test-Path -LiteralPath $script:SecretsFile) {
        $existing = Get-Content -LiteralPath $script:SecretsFile -Raw | ConvertFrom-Json
        if (-not $existing.OperPassword -or -not $existing.AdminPassword) {
            throw "Existing secrets file is incomplete: $script:SecretsFile"
        }
        if ($existing.AdminAccount -ne $AdminAccount) {
            throw "Existing admin account '$($existing.AdminAccount)' differs from requested '$AdminAccount'. Reuse the existing value or rotate it explicitly."
        }
        return $existing
    }

    $secrets = [ordered]@{
        OperUsername = 'admin'
        OperPassword = New-StrongSecret
        AdminAccount = $AdminAccount
        AdminPassword = New-StrongSecret
        CreatedUtc = [DateTime]::UtcNow.ToString('o')
    }
    Write-Utf8NoBom -Path $script:SecretsFile -Content ($secrets | ConvertTo-Json)
    Protect-SecretFile -Path $script:SecretsFile
    return [pscustomobject]$secrets
}

function Get-OperPasswordHash {
    param([Parameter(Mandatory)][string]$Password)
    $hashLines = $Password | & docker run --rm -i --entrypoint /ircd-bin/ergo $script:ErgoImage genpasswd --quiet 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Ergo password hashing failed: $($hashLines -join "`n")"
    }
    $hash = [string]($hashLines | Select-Object -Last 1)
    $hash = $hash.Trim()
    if ($hash -notmatch '^\$2[aby]\$\d\d\$') {
        throw 'Ergo returned an invalid operator password hash.'
    }
    return $hash
}

function Render-ErgoConfig {
    param(
        [Parameter(Mandatory)][string]$OperHash
    )
    $templatePath = Join-Path $script:Root 'config\ergo\ircd.template.yaml'
    $outputPath = Join-Path $script:Root 'config\ergo\ircd.yaml'
    $content = Get-Content -LiteralPath $templatePath -Raw
    $content = $content.Replace('@@NETWORK_NAME@@', $NetworkName)
    $content = $content.Replace('@@SERVER_NAME@@', $TailscaleHostname)
    $content = $content.Replace('@@OPER_PASSWORD_HASH@@', $OperHash)
    if ($content -match '@@[A-Z0-9_]+@@') {
        throw 'Not all Ergo configuration tokens were replaced.'
    }
    Write-Utf8NoBom -Path $outputPath -Content $content
}

function Write-LocalEnvironment {
    param(
        [Parameter(Mandatory)][string]$HostBindIP,
        [string]$ProbeHost
    )
    $content = @"
TAILSCALE_IP=$TailscaleIP
TAILSCALE_HOSTNAME=$TailscaleHostname
HOST_BIND_IP=$HostBindIP
TAILNET_PROBE_HOST=$ProbeHost
ERGO_TLS_PORT=6697
THELOUNGE_PORT=9000
ERGO_NETWORK_NAME=$NetworkName
ERGO_ADMIN_ACCOUNT=$AdminAccount
"@
    Write-Utf8NoBom -Path $script:EnvFile -Content $content
}

function Wait-ServiceHealth {
    param(
        [Parameter(Mandatory)][string]$Service,
        [int]$TimeoutSeconds = 120
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $containerId = (& docker compose --env-file $script:EnvFile -f $script:ComposeFile ps -q $Service 2>$null | Select-Object -First 1)
        if ($containerId) {
            $state = (& docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' $containerId 2>$null)
            if ($LASTEXITCODE -eq 0 -and $state -eq 'running|healthy') {
                return
            }
            if ($state -match '^exited|^dead') {
                $logs = & docker compose --env-file $script:EnvFile -f $script:ComposeFile logs --tail 80 $Service 2>&1
                throw "$Service exited before becoming healthy:`n$($logs -join "`n")"
            }
        }
        Start-Sleep -Seconds 3
    }
    $finalLogs = & docker compose --env-file $script:EnvFile -f $script:ComposeFile logs --tail 80 $Service 2>&1
    throw "$Service did not become healthy within $TimeoutSeconds seconds:`n$($finalLogs -join "`n")"
}

function Invoke-LocalIrcSession {
    param(
        [Parameter(Mandatory)][string[]]$Commands,
        [int]$DelayMilliseconds = 450
    )

    $containerId = (& docker compose --env-file $script:EnvFile -f $script:ComposeFile ps -q ergo | Select-Object -First 1)
    if (-not $containerId) {
        throw 'Cannot locate the running Ergo container.'
    }

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = 'docker'
    $startInfo.Arguments = "exec -i $containerId nc 127.0.0.1 6667"
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw 'Could not start local IRC bootstrap session.'
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()

    foreach ($command in $Commands) {
        $process.StandardInput.WriteLine($command)
        $process.StandardInput.Flush()
        Start-Sleep -Milliseconds $DelayMilliseconds
    }
    $process.StandardInput.Close()

    $timedOut = -not $process.WaitForExit(30000)
    if ($timedOut) {
        $process.Kill()
        [void]$process.WaitForExit(5000)
    }
    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result
    if ($timedOut -and -not $stdout) {
        throw 'Local IRC bootstrap session timed out without a server response.'
    }
    if ($process.ExitCode -ne 0 -and -not $stdout) {
        throw "Local IRC bootstrap session failed: $stderr"
    }
    return $stdout
}

function Initialize-ErgoState {
    param([Parameter(Mandatory)]$Secrets)

    $registration = Invoke-LocalIrcSession -Commands @(
        'NICK BootstrapOper'
        'USER bootstrap 0 * :Bootstrap operator'
        "OPER $($Secrets.OperUsername) $($Secrets.OperPassword)"
        "PRIVMSG NickServ :SAREGISTER $($Secrets.AdminAccount) $($Secrets.AdminPassword)"
        'QUIT :Bootstrap registration complete'
    )
    if ($registration -notmatch 'Successfully registered account|Account already exists|Name reserved due to a prior registration') {
        throw "Could not create or confirm the initial Ergo account. Server response:`n$registration"
    }

    $saslPlain = ([char]0) + $Secrets.AdminAccount + ([char]0) + $Secrets.AdminPassword
    $saslPayload = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($saslPlain))
    $channels = Invoke-LocalIrcSession -Commands @(
        'CAP LS 302'
        "NICK $($Secrets.AdminAccount)"
        'USER bootstrap 0 * :Bootstrap channel registration'
        'CAP REQ :sasl'
        'AUTHENTICATE PLAIN'
        "AUTHENTICATE $saslPayload"
        'CAP END'
        "OPER $($Secrets.OperUsername) $($Secrets.OperPassword)"
        'PRIVMSG NickServ :SET MULTICLIENT ON'
        'PRIVMSG NickServ :SET ALWAYS-ON TRUE'
        'PRIVMSG NickServ :SET AUTOREPLAY-MISSED ON'
        'PRIVMSG NickServ :SET AUTOREPLAY-LINES 100'
        'PRIVMSG NickServ :SET DM-HISTORY ON'
        'PRIVMSG NickServ :SET AUTO-AWAY ON'
        'JOIN #general'
        'PRIVMSG ChanServ :REGISTER #general'
        'JOIN #ops'
        'PRIVMSG ChanServ :REGISTER #ops'
        'PRIVMSG ChanServ :INFO #general'
        'PRIVMSG ChanServ :INFO #ops'
        'PRIVMSG #ops :Infrastructure channel initialized by bootstrap.'
        'QUIT :Bootstrap channel setup complete'
    )
    if ($channels -notmatch 'Channel #general is registered' -or $channels -notmatch 'Channel #ops is registered') {
        throw "Could not create or confirm the initial channels. Server response:`n$channels"
    }
}

Push-Location $script:Root
try {
    Write-Step 'Checking Docker, Compose, and Tailscale'
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'docker.exe was not found on PATH.'
    }
    & docker compose version *> $null
    if ($LASTEXITCODE -ne 0) {
        throw 'Docker Compose v2 is unavailable.'
    }
    Start-DockerEngineIfNeeded
    $tailscaleIdentity = Get-TailscaleIdentity
    $TailscaleIP = $tailscaleIdentity.IP
    $TailscaleHostname = $tailscaleIdentity.Hostname
    $tailnetProbeHost = $tailscaleIdentity.ProbeHost
    if (-not (Test-TailscaleIPv4 -Address $TailscaleIP)) {
        throw "'$TailscaleIP' is not an IPv4 address in Tailscale's 100.64.0.0/10 range."
    }
    if ($TailscaleHostname -notmatch '\.ts\.net$') {
        throw "'$TailscaleHostname' is not a MagicDNS hostname ending in .ts.net."
    }

    Write-Step 'Creating local directories and deployment parameters'
    foreach ($directory in @(
        '.secrets',
        'data\ergo',
        'data\thelounge',
        'backups'
    )) {
        [void](New-Item -ItemType Directory -Path (Join-Path $script:Root $directory) -Force)
    }
    $hostBindIP = $TailscaleIP
    if (Test-Path -LiteralPath $script:EnvFile) {
        $existingBindLine = Get-Content -LiteralPath $script:EnvFile | Where-Object { $_ -match '^HOST_BIND_IP=' } | Select-Object -First 1
        if ($existingBindLine -eq 'HOST_BIND_IP=0.0.0.0') {
            $hostBindIP = '0.0.0.0'
        }
    }
    Write-LocalEnvironment -HostBindIP $hostBindIP -ProbeHost $tailnetProbeHost
    $secrets = Get-OrCreateSecrets

    Write-Step 'Pulling pinned official images'
    Invoke-Docker -Arguments @('compose', '--env-file', $script:EnvFile, '-f', $script:ComposeFile, 'pull')

    Write-Step 'Rendering and validating Ergo configuration'
    $operHash = Get-OperPasswordHash -Password $secrets.OperPassword
    Render-ErgoConfig -OperHash $operHash
    Invoke-Docker -Arguments @('compose', '--env-file', $script:EnvFile, '-f', $script:ComposeFile, 'config', '--quiet')

    $certPath = Join-Path $script:Root 'data\ergo\fullchain.pem'
    $keyPath = Join-Path $script:Root 'data\ergo\privkey.pem'
    if ((Test-Path -LiteralPath $certPath) -xor (Test-Path -LiteralPath $keyPath)) {
        throw 'Only one of the Ergo TLS certificate/key files exists. Restore the matching file or rotate the pair explicitly.'
    }
    if (-not (Test-Path -LiteralPath $certPath)) {
        Invoke-Docker -Arguments @(
            'compose', '--env-file', $script:EnvFile, '-f', $script:ComposeFile,
            'run', '--rm', '--no-deps', 'ergo',
            'mkcerts', '--conf', '/ircd/ircd.yaml', '--quiet'
        )
    }

    Write-Step 'Staging The Lounge configuration'
    Invoke-Docker -Arguments @(
        'compose', '--env-file', $script:EnvFile, '-f', $script:ComposeFile,
        'run', '--rm', '--no-deps', '--entrypoint', 'sh', 'thelounge',
        '-c', 'rm -f /var/opt/thelounge/config.js && cp /defaults/config.js /var/opt/thelounge/config.js'
    )

    $existingErgo = (& docker compose --env-file $script:EnvFile -f $script:ComposeFile ps -q ergo 2>$null)
    if (-not $existingErgo) {
        Invoke-Docker -Arguments @(
            'compose', '--env-file', $script:EnvFile, '-f', $script:ComposeFile,
            'run', '--rm', '--no-deps', 'ergo',
            'run', '--conf', '/ircd/ircd.yaml', '--quiet', '--smoke'
        )
    }

    Write-Step 'Starting Ergo and The Lounge'
    Invoke-Docker -Arguments @(
        'compose', '--env-file', $script:EnvFile, '-f', $script:ComposeFile,
        'up', '-d', '--remove-orphans'
    )
    Wait-ServiceHealth -Service ergo
    Wait-ServiceHealth -Service thelounge
    Invoke-Docker -Arguments @(
        'compose', '--env-file', $script:EnvFile, '-f', $script:ComposeFile,
        'restart', 'thelounge'
    )
    Wait-ServiceHealth -Service thelounge

    if (-not (Test-TcpEndpoint -Address $TailscaleIP -Port 6697)) {
        if ($hostBindIP -eq $TailscaleIP) {
            Write-Warning 'Docker Desktop recorded the Tailscale-specific port binding but did not create a usable Windows listener. Enabling the firewall-validated wildcard fallback.'
            Assert-FirewallFallbackSafe
            $hostBindIP = '0.0.0.0'
            Write-LocalEnvironment -HostBindIP $hostBindIP -ProbeHost $tailnetProbeHost
            Invoke-Docker -Arguments @(
                'compose', '--env-file', $script:EnvFile, '-f', $script:ComposeFile,
                'up', '-d', '--force-recreate'
            )
            Wait-ServiceHealth -Service ergo
            Wait-ServiceHealth -Service thelounge
        } else {
            Assert-FirewallFallbackSafe
        }
        if (-not (Test-TcpEndpoint -Address $TailscaleIP -Port 6697)) {
            if (Test-RemoteTailnetPort -ProbeHost $tailnetProbeHost -Port 6697) {
                Write-Host "Remote tailnet probe $tailnetProbeHost reached ${TailscaleIP}:6697."
            } elseif (Test-TcpEndpoint -Address '127.0.0.1' -Port 6697) {
                Write-Warning 'Windows cannot loop back through its own Tailscale address. Localhost works, but no remote tailnet SSH probe was available.'
            } else {
                throw "Firewall fallback did not make IRC reachable on either localhost or ${TailscaleIP}:6697."
            }
        }
    }

    Write-Step 'Creating the initial account and registered channels'
    Initialize-ErgoState -Secrets $secrets

    Write-Step 'Running deployment checks'
    $checkArguments = @{
        TailscaleIP = $TailscaleIP
        TailscaleHostname = $TailscaleHostname
    }
    if (-not $SkipPersistenceTest) {
        $checkArguments.Persistence = $true
    }
    & (Join-Path $PSScriptRoot 'check.ps1') @checkArguments
    if (-not $?) {
        throw 'Validation checks failed.'
    }

    Write-Host "`nDeployment is ready." -ForegroundColor Green
    Write-Host "Quassel application: Quassel Monolithic/Standalone (no remote Quassel Core)"
    Write-Host "IRC server:          $TailscaleHostname"
    Write-Host "IRC port:            6697"
    Write-Host "TLS:                 Enabled; trust the self-signed certificate once"
    Write-Host "IRC/SASL account:    $($secrets.AdminAccount)"
    Write-Host "Account password:    stored in .secrets\bootstrap.json"
    Write-Host "Automatic joins:     #general,#ops"
    Write-Host "The Lounge:          http://${TailscaleHostname}:9000/"
    Write-Host "Add Lounge user:     docker compose exec thelounge thelounge add <username>"
} finally {
    Pop-Location
}
