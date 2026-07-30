[CmdletBinding()]
param(
    [string]$TailscaleIP,
    [string]$TailscaleHostname,
    [string]$TailnetProbeHost,
    [switch]$Persistence
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script:ComposeFile = Join-Path $script:Root 'compose.yaml'
$script:EnvFile = Join-Path $script:Root '.env'
$script:SecretsFile = Join-Path $script:Root '.secrets\bootstrap.json'
$script:Passed = 0
$script:Warnings = 0

function Write-Pass {
    param([string]$Message)
    $script:Passed++
    Write-Host "[PASS] $Message" -ForegroundColor Green
}

function Write-CheckWarning {
    param([string]$Message)
    $script:Warnings++
    Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

function Get-EnvMap {
    $map = @{}
    foreach ($line in Get-Content -LiteralPath $script:EnvFile) {
        if ($line -match '^\s*([^#][^=]*)=(.*)$') {
            $map[$matches[1].Trim()] = $matches[2].Trim()
        }
    }
    return $map
}

function Invoke-DockerCapture {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & docker @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($exitCode -ne 0) {
        throw "docker $($Arguments -join ' ') failed:`n$($output -join "`n")"
    }
    return ($output -join "`n")
}

function Get-ServiceContainer {
    param([Parameter(Mandatory)][string]$Service)
    $id = (& docker compose --env-file $script:EnvFile -f $script:ComposeFile ps -q $Service 2>$null | Select-Object -First 1)
    if (-not $id) {
        throw "Compose service '$Service' has no container."
    }
    return [string]$id
}

function Wait-ServiceHealthy {
    param(
        [Parameter(Mandatory)][string]$Service,
        [int]$TimeoutSeconds = 120
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $id = Get-ServiceContainer -Service $Service
            $state = & docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' $id 2>$null
            if ($LASTEXITCODE -eq 0 -and $state -eq 'running|healthy') {
                return
            }
        } catch {
            # Container creation can briefly race this poll.
        }
        Start-Sleep -Seconds 3
    }
    throw "$Service did not become healthy within $TimeoutSeconds seconds."
}

function Test-TcpConnect {
    param(
        [Parameter(Mandatory)][string]$Address,
        [Parameter(Mandatory)][int]$Port,
        [int]$TimeoutMilliseconds = 1500
    )
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect($Address, $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMilliseconds, $false)) {
            return $false
        }
        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function New-TemporarySecret {
    $bytes = New-Object byte[] 24
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    } finally {
        $rng.Dispose()
    }
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Test-RemoteTailnetEndpoint {
    param(
        [Parameter(Mandatory)][string]$ProbeHost,
        [Parameter(Mandatory)][int]$Port,
        [switch]$Http
    )
    if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
        return $false
    }
    $remoteCommand = if ($Http) {
        "curl -fsS --max-time 5 http://${TailscaleIP}:$Port/ >/dev/null"
    } else {
        "nc -z -w 5 $TailscaleIP $Port"
    }
    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & ssh -o BatchMode=yes -o ConnectTimeout=5 -o UserKnownHostsFile=NUL -o StrictHostKeyChecking=no -o LogLevel=ERROR $ProbeHost $remoteCommand *> $null
        $sshExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    return ($sshExitCode -eq 0)
}

function Invoke-IrcTlsConversation {
    param(
        [Parameter(Mandatory)][string[]]$Commands,
        [string]$Account,
        [string]$Password
    )

    $client = New-Object System.Net.Sockets.TcpClient
    $client.ReceiveTimeout = 10000
    $client.SendTimeout = 10000
    $client.Connect($script:ClientConnectAddress, 6697)
    $networkStream = $client.GetStream()
    $validationCallback = { $true } -as [System.Net.Security.RemoteCertificateValidationCallback]
    $tlsStream = New-Object System.Net.Security.SslStream($networkStream, $false, $validationCallback)
    $tlsStream.AuthenticateAsClient($TailscaleHostname)
    $certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($tlsStream.RemoteCertificate)
    $writer = New-Object System.IO.StreamWriter($tlsStream, (New-Object System.Text.UTF8Encoding($false)))
    $writer.NewLine = "`r`n"
    $writer.AutoFlush = $true

    try {
        $nick = if ($Account) { $Account } else { 'HealthProbe' }
        $writer.WriteLine('CAP LS 302')
        $writer.WriteLine("NICK $nick")
        $writer.WriteLine("USER health 0 * :Deployment health check")
        if ($Account) {
            $writer.WriteLine('CAP REQ :sasl')
            $writer.WriteLine('CAP REQ :draft/chathistory')
            $writer.WriteLine('AUTHENTICATE PLAIN')
            $plain = ([char]0) + $Account + ([char]0) + $Password
            $payload = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($plain))
            $writer.WriteLine("AUTHENTICATE $payload")
        }
        $writer.WriteLine('CAP END')
        Start-Sleep -Milliseconds 500
        foreach ($command in $Commands) {
            $writer.WriteLine($command)
            Start-Sleep -Milliseconds 180
        }
        $writer.WriteLine('QUIT :Health check complete')

        $reader = New-Object System.IO.StreamReader($tlsStream, [System.Text.Encoding]::UTF8)
        $response = $reader.ReadToEnd()
        return [pscustomobject]@{
            Response = $response
            Certificate = $certificate
        }
    } finally {
        $writer.Dispose()
        $tlsStream.Dispose()
        $networkStream.Dispose()
        $client.Close()
    }
}

function New-IrcTlsSession {
    param(
        [Parameter(Mandatory)][string]$Account,
        [Parameter(Mandatory)][string]$Password
    )
    $client = New-Object System.Net.Sockets.TcpClient
    $client.ReceiveTimeout = 10000
    $client.SendTimeout = 10000
    $client.Connect($script:ClientConnectAddress, 6697)
    $networkStream = $client.GetStream()
    $validationCallback = { $true } -as [System.Net.Security.RemoteCertificateValidationCallback]
    $tlsStream = New-Object System.Net.Security.SslStream($networkStream, $false, $validationCallback)
    $tlsStream.AuthenticateAsClient($TailscaleHostname)
    $writer = New-Object System.IO.StreamWriter($tlsStream, (New-Object System.Text.UTF8Encoding($false)))
    $writer.NewLine = "`r`n"
    $writer.AutoFlush = $true
    $plain = ([char]0) + $Account + ([char]0) + $Password
    $payload = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($plain))
    foreach ($line in @(
        'CAP LS 302',
        "NICK $Account",
        'USER multiclient 0 * :Multiclient validation',
        'CAP REQ :sasl',
        'AUTHENTICATE PLAIN',
        "AUTHENTICATE $payload",
        'CAP END'
    )) {
        $writer.WriteLine($line)
        Start-Sleep -Milliseconds 100
    }
    return [pscustomobject]@{
        Client = $client
        NetworkStream = $networkStream
        TlsStream = $tlsStream
        Writer = $writer
    }
}

function Close-IrcTlsSession {
    param(
        [Parameter(Mandatory)]$Session,
        [Parameter(Mandatory)][string]$PingToken
    )
    try {
        $Session.Writer.WriteLine("PING :$PingToken")
        $Session.Writer.WriteLine('QUIT :Multiclient validation complete')
        $reader = New-Object System.IO.StreamReader($Session.TlsStream, [System.Text.Encoding]::UTF8)
        return $reader.ReadToEnd()
    } finally {
        $Session.Writer.Dispose()
        $Session.TlsStream.Dispose()
        $Session.NetworkStream.Dispose()
        $Session.Client.Close()
    }
}

function Assert-MulticlientAttach {
    param(
        [Parameter(Mandatory)][string]$Account,
        [Parameter(Mandatory)][string]$Password
    )
    $first = $null
    $second = $null
    try {
        $first = New-IrcTlsSession -Account $Account -Password $Password
        Start-Sleep -Milliseconds 700
        $second = New-IrcTlsSession -Account $Account -Password $Password
        Start-Sleep -Milliseconds 700
        $firstResponse = Close-IrcTlsSession -Session $first -PingToken 'multi-one'
        $first = $null
        $secondResponse = Close-IrcTlsSession -Session $second -PingToken 'multi-two'
        $second = $null
        foreach ($result in @($firstResponse, $secondResponse)) {
            if ($result -notmatch ' 903 ' -or $result -notmatch " 001 $([regex]::Escape($Account)) ") {
                throw "A simultaneous session did not authenticate as $Account."
            }
            if ($result -match ' 433 ') {
                throw 'Ergo returned nickname-in-use during simultaneous authenticated sessions.'
            }
        }
        Write-Pass "Two simultaneous TLS/SASL sessions attached to account/nickname '$Account' without collision"
    } finally {
        foreach ($session in @($first, $second)) {
            if ($session) {
                try {
                    $session.Writer.WriteLine('QUIT :Cleanup')
                    $session.Writer.Dispose()
                    $session.TlsStream.Dispose()
                    $session.NetworkStream.Dispose()
                    $session.Client.Close()
                } catch {
                    # Preserve the original assertion error.
                }
            }
        }
    }
}

function Assert-ServiceState {
    param([Parameter(Mandatory)][string]$Service)
    $id = Get-ServiceContainer -Service $Service
    $inspection = (& docker inspect $id | ConvertFrom-Json)[0]
    if ($inspection.State.Status -ne 'running') {
        throw "$Service is not running (state: $($inspection.State.Status))."
    }
    if ($inspection.State.Health.Status -ne 'healthy') {
        throw "$Service is not healthy (health: $($inspection.State.Health.Status))."
    }
    $restartBefore = [int]$inspection.RestartCount
    Start-Sleep -Seconds 3
    $restartAfter = [int]((& docker inspect $id | ConvertFrom-Json)[0].RestartCount)
    if ($restartAfter -ne $restartBefore) {
        throw "$Service restarted during the observation window."
    }
    Write-Pass "$Service is running, healthy, and not restart-looping (restart count $restartAfter)"
}

function Assert-PortBinding {
    param(
        [Parameter(Mandatory)][string]$Service,
        [Parameter(Mandatory)][string]$ContainerPort,
        [Parameter(Mandatory)][int]$HostPort
    )
    $id = Get-ServiceContainer -Service $Service
    $inspection = (& docker inspect $id | ConvertFrom-Json)[0]
    $portProperty = $inspection.NetworkSettings.Ports.PSObject.Properties[$ContainerPort]
    $binding = if ($portProperty) { $portProperty.Value | Select-Object -First 1 } else { $null }
    if (-not $binding) {
        throw "$Service has no published binding for $ContainerPort."
    }
    $expectedBind = $script:HostBindIP
    if ($binding.HostIp -ne $expectedBind -or [int]$binding.HostPort -ne $HostPort) {
        throw "$Service $ContainerPort is bound to $($binding.HostIp):$($binding.HostPort), expected ${expectedBind}:$HostPort."
    }
    Write-Pass "$Service publishes $ContainerPort on ${expectedBind}:$HostPort"
}

function Assert-Mount {
    param(
        [Parameter(Mandatory)][string]$Service,
        [Parameter(Mandatory)][string]$Destination
    )
    $id = Get-ServiceContainer -Service $Service
    $inspection = (& docker inspect $id | ConvertFrom-Json)[0]
    $mount = @($inspection.Mounts | Where-Object { $_.Destination -eq $Destination }) | Select-Object -First 1
    if (-not $mount) {
        throw "$Service is missing its $Destination mount."
    }
    if (-not (Test-Path -LiteralPath $mount.Source)) {
        throw "$Service mount source does not exist: $($mount.Source)"
    }
    Write-Pass "$Service persistent mount exists: $($mount.Source) -> $Destination"
}

function Get-LoungeUsers {
    $usersPath = Join-Path $script:Root 'data\thelounge\users'
    if (-not (Test-Path -LiteralPath $usersPath)) {
        return @()
    }
    return @(Get-ChildItem -LiteralPath $usersPath -Filter '*.json' -File | Select-Object -ExpandProperty BaseName)
}

Push-Location $script:Root
try {
    if (-not (Test-Path -LiteralPath $script:EnvFile)) {
        throw 'Missing .env. Run scripts\bootstrap.ps1 first.'
    }
    $envMap = Get-EnvMap
    if (-not $TailscaleIP) {
        $TailscaleIP = $envMap.TAILSCALE_IP
    }
    if (-not $TailscaleHostname) {
        $TailscaleHostname = $envMap.TAILSCALE_HOSTNAME
    }
    if (-not $TailnetProbeHost -and $envMap.ContainsKey('TAILNET_PROBE_HOST')) {
        $TailnetProbeHost = $envMap.TAILNET_PROBE_HOST
    }
    $script:HostBindIP = if ($envMap.ContainsKey('HOST_BIND_IP')) { $envMap.HOST_BIND_IP } else { $TailscaleIP }
    if (-not (Test-Path -LiteralPath $script:SecretsFile)) {
        throw 'Missing ignored bootstrap credentials; authenticated checks cannot run.'
    }
    $secrets = Get-Content -LiteralPath $script:SecretsFile -Raw | ConvertFrom-Json

    Invoke-DockerCapture -Arguments @('compose', '--env-file', $script:EnvFile, '-f', $script:ComposeFile, 'config', '--quiet') | Out-Null
    Write-Pass 'Compose configuration is valid'

    Assert-ServiceState -Service ergo
    Assert-ServiceState -Service thelounge
    Assert-Mount -Service ergo -Destination '/var/lib/ergo'
    Assert-Mount -Service thelounge -Destination '/var/opt/thelounge'
    Assert-PortBinding -Service ergo -ContainerPort '6697/tcp' -HostPort 6697
    Assert-PortBinding -Service thelounge -ContainerPort '9000/tcp' -HostPort 9000

    foreach ($path in @(
        'data\ergo\ircd.db',
        'data\ergo\ergo_history.db',
        'data\ergo\fullchain.pem',
        'data\ergo\privkey.pem'
    )) {
        $fullPath = Join-Path $script:Root $path
        if (-not (Test-Path -LiteralPath $fullPath)) {
            throw "Required persistent file is missing: $path"
        }
    }
    Write-Pass 'Ergo account database, history database, and TLS material exist'

    $ergoId = Get-ServiceContainer -Service ergo
    $listenTest = & docker exec $ergoId sh -c 'nc -z -w 2 127.0.0.1 6667 && nc -z -w 2 127.0.0.1 6697'
    if ($LASTEXITCODE -ne 0) {
        throw 'Ergo is not listening on both internal IRC ports.'
    }
    Write-Pass 'Ergo listens on internal plaintext 6667 and TLS 6697'

    $dnsScript = "require('dns').lookup('ergo',(e,a)=>{if(e){console.error(e);process.exit(1)};console.log(a)})"
    $dnsResult = & docker compose --env-file $script:EnvFile -f $script:ComposeFile exec -T thelounge node -e $dnsScript 2>&1
    if ($LASTEXITCODE -ne 0 -or -not $dnsResult) {
        throw "The Lounge cannot resolve the internal Ergo hostname: $($dnsResult -join "`n")"
    }
    Write-Pass "The Lounge resolves internal service hostname 'ergo' to $($dnsResult | Select-Object -Last 1)"

    $localTailnetLoopback = Test-TcpConnect -Address $TailscaleIP -Port 6697
    $remoteIrcReachable = $false
    $remoteWebReachable = $false
    if (-not $localTailnetLoopback -and $TailnetProbeHost) {
        $remoteIrcReachable = Test-RemoteTailnetEndpoint -ProbeHost $TailnetProbeHost -Port 6697
        $remoteWebReachable = Test-RemoteTailnetEndpoint -ProbeHost $TailnetProbeHost -Port 9000 -Http
    }
    if (-not $localTailnetLoopback -and -not $remoteIrcReachable) {
        throw "Tailnet IRC endpoint ${TailscaleIP}:6697 is unreachable locally and from probe '$TailnetProbeHost'."
    }
    if ($remoteIrcReachable) {
        Write-Pass "Remote tailnet peer $TailnetProbeHost reaches ${TailscaleIP}:6697"
    } else {
        Write-Pass "Tailnet IRC endpoint ${TailscaleIP}:6697 is reachable"
    }
    $script:ClientConnectAddress = if ($localTailnetLoopback) { $TailscaleIP } else { '127.0.0.1' }

    $webAddress = if ($localTailnetLoopback) { $TailscaleIP } else { '127.0.0.1' }
    $webResponse = Invoke-WebRequest -UseBasicParsing -Uri "http://${webAddress}:9000/" -TimeoutSec 10
    if ($webResponse.StatusCode -ne 200) {
        throw "The Lounge returned HTTP $($webResponse.StatusCode)."
    }
    if ($remoteWebReachable) {
        Write-Pass "Remote tailnet peer $TailnetProbeHost reaches http://${TailscaleIP}:9000/"
    } elseif ($localTailnetLoopback) {
        Write-Pass "The Lounge is reachable at http://${TailscaleIP}:9000/"
    } else {
        Write-CheckWarning 'The Lounge is healthy on localhost, but no remote tailnet HTTP probe was available.'
    }

    $protocol = Invoke-IrcTlsConversation -Account $secrets.AdminAccount -Password $secrets.AdminPassword -Commands @(
        "PRIVMSG NickServ :INFO $($secrets.AdminAccount)"
        'PRIVMSG ChanServ :INFO #general'
        'PRIVMSG ChanServ :INFO #ops'
    )
    if ($protocol.Response -notmatch ' 903 ' -or $protocol.Response -notmatch ' 001 ') {
        throw "IRC SASL authentication did not complete successfully:`n$($protocol.Response)"
    }
    if ($protocol.Response -notmatch '#general' -or $protocol.Response -notmatch '#ops') {
        throw "Registered channels were not confirmed over IRC:`n$($protocol.Response)"
    }
    Write-Pass 'IRC protocol negotiation, SASL login, account lookup, and registered channel lookup succeeded'
    Assert-MulticlientAttach -Account $secrets.AdminAccount -Password $secrets.AdminPassword

    $sanExtension = $protocol.Certificate.Extensions |
        Where-Object { $_.Oid.Value -eq '2.5.29.17' } |
        Select-Object -First 1
    $sanText = if ($sanExtension) { $sanExtension.Format($true) } else { '' }
    if ($sanText -notmatch [regex]::Escape($TailscaleHostname)) {
        throw "TLS certificate subject alternative names do not include '$TailscaleHostname': $sanText"
    }
    if ($protocol.Certificate.NotAfter -le [DateTime]::Now.AddDays(7)) {
        throw "TLS certificate expires too soon: $($protocol.Certificate.NotAfter)"
    }
    $fingerprint = $protocol.Certificate.GetCertHashString(
        [System.Security.Cryptography.HashAlgorithmName]::SHA256
    )
    Write-Pass "TLS certificate covers $TailscaleHostname, expires $($protocol.Certificate.NotAfter.ToString('u')), SHA-256 $fingerprint"

    if ($script:HostBindIP -eq $TailscaleIP) {
        $otherAddresses = @(
            Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
                Where-Object {
                    $_.IPAddress -ne $TailscaleIP -and
                    $_.IPAddress -ne '127.0.0.1' -and
                    $_.IPAddress -notlike '169.254.*'
                } |
                Select-Object -ExpandProperty IPAddress -Unique
        )
        foreach ($address in $otherAddresses) {
            foreach ($port in @(6697, 9000)) {
                if (Test-TcpConnect -Address $address -Port $port -TimeoutMilliseconds 700) {
                    throw "Port $port is unexpectedly reachable through non-Tailscale address $address."
                }
            }
        }
        Write-Pass "Published ports are not reachable on $($otherAddresses.Count) non-Tailscale local IPv4 address(es)"
    } else {
        if ($script:HostBindIP -ne '0.0.0.0') {
            throw "Unexpected fallback bind address: $script:HostBindIP"
        }
        $policy = (& netsh advfirewall show allprofiles firewallpolicy 2>&1) -join "`n"
        if ($LASTEXITCODE -ne 0 -or $policy -notmatch 'BlockInbound,AllowOutbound') {
            throw 'Wildcard bindings require BlockInbound Windows Firewall policy on all profiles.'
        }
        $tailProfile = Get-NetConnectionProfile -InterfaceAlias 'Tailscale' -ErrorAction Stop
        if ($tailProfile.NetworkCategory -notin @('Private', 'DomainAuthenticated')) {
            throw "Tailscale interface has unsafe firewall category: $($tailProfile.NetworkCategory)"
        }
        $tailAllow = Get-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -ErrorAction Stop |
            Where-Object {
                $addressFilter = $_ | Get-NetFirewallAddressFilter -ErrorAction SilentlyContinue
                $addressFilter.LocalAddress -contains $TailscaleIP
            } |
            Select-Object -First 1
        if (-not $tailAllow) {
            throw "No enabled inbound firewall rule is scoped to local Tailscale address $TailscaleIP."
        }
        $unsafeRules = @(
            Get-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -ErrorAction SilentlyContinue |
                Where-Object {
                    $portFilter = $_ | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
                    $addressFilter = $_ | Get-NetFirewallAddressFilter -ErrorAction SilentlyContinue
                    ($portFilter.LocalPort -contains '6697' -or $portFilter.LocalPort -contains '9000') -and
                    ($addressFilter.LocalAddress -contains 'Any') -and
                    ($addressFilter.RemoteAddress -contains 'Any')
                }
        )
        if ($unsafeRules.Count -gt 0) {
            throw "Broad inbound allow rule(s) expose IRC ports: $($unsafeRules.DisplayName -join ', ')"
        }
        Write-Pass 'Wildcard Docker Desktop listeners are constrained by enabled BlockInbound policy and a Tailscale-address-scoped allow rule'
    }

    if ($Persistence) {
        Write-Host "`nRunning controlled restart persistence test..." -ForegroundColor Cyan
        $marker = "persistence-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
        $send = Invoke-IrcTlsConversation -Account $secrets.AdminAccount -Password $secrets.AdminPassword -Commands @(
            'JOIN #ops'
            "PRIVMSG #ops :$marker"
        )
        if ($send.Response -notmatch ' 903 ') {
            throw 'Could not authenticate while writing the persistence marker.'
        }

        $probeUser = "probe$([Guid]::NewGuid().ToString('N').Substring(0,10))"
        $probePassword = New-TemporarySecret
        $probeOutput = Invoke-DockerCapture -Arguments @(
            'compose', '--env-file', $script:EnvFile, '-f', $script:ComposeFile,
            'exec', '-T', 'thelounge', 'thelounge', 'add', '--password', $probePassword, $probeUser
        )
        $probePath = Join-Path $script:Root "data\thelounge\users\$probeUser.json"
        if (-not (Test-Path -LiteralPath $probePath)) {
            throw 'The Lounge temporary user file was not persisted to the bind mount.'
        }

        Invoke-DockerCapture -Arguments @(
            'compose', '--env-file', $script:EnvFile, '-f', $script:ComposeFile,
            'restart'
        ) | Out-Null
        Wait-ServiceHealthy -Service ergo
        Wait-ServiceHealthy -Service thelounge

        $history = Invoke-IrcTlsConversation -Account $secrets.AdminAccount -Password $secrets.AdminPassword -Commands @(
            "PRIVMSG NickServ :INFO $($secrets.AdminAccount)"
            'PRIVMSG ChanServ :INFO #general'
            'PRIVMSG ChanServ :INFO #ops'
            'JOIN #ops'
            'CHATHISTORY LATEST #ops * 100'
        )
        if ($history.Response -notmatch [regex]::Escape($marker)) {
            throw "Persistent history marker was not replayed after restart:`n$($history.Response)"
        }
        if ($history.Response -notmatch '#general' -or $history.Response -notmatch '#ops') {
            throw 'Account/channel state was not visible after restart.'
        }
        if (-not (Test-Path -LiteralPath $probePath)) {
            throw 'The Lounge user did not survive the Compose restart.'
        }
        Write-Pass 'Ergo account, registered channels, and message history survived restart'
        Write-Pass 'The Lounge user configuration survived restart'

        $removeOutput = $null
        try {
            $removeOutput = Invoke-DockerCapture -Arguments @(
                'compose', '--env-file', $script:EnvFile, '-f', $script:ComposeFile,
                'exec', '-T', 'thelounge', 'thelounge', 'remove', $probeUser
            )
        } catch {
            Write-CheckWarning "Temporary Lounge user '$probeUser' passed persistence testing but could not be removed automatically."
        }
        if ($removeOutput) {
            Write-Pass 'Temporary The Lounge validation user was removed'
        }
    } else {
        Write-CheckWarning 'Controlled restart persistence test was skipped; rerun with -Persistence to execute it.'
    }

    $loungeUsers = @(Get-LoungeUsers)
    if ($loungeUsers.Count -eq 0) {
        Write-CheckWarning 'No permanent The Lounge user exists, as intended; add a personal user interactively before browser login.'
    } else {
        Write-Pass "The Lounge has $($loungeUsers.Count) persistent user configuration(s)"
    }

    Write-Host "`nValidation complete: $script:Passed passed, $script:Warnings warning(s)." -ForegroundColor Green
} finally {
    Pop-Location
}
