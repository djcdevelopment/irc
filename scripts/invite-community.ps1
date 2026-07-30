[CmdletBinding()]
param(
    [ValidateNotNullOrEmpty()]
    [string]$DisplayName = "Friend",

    [string]$SshHost = "am4"
)

$ErrorActionPreference = "Stop"
$encodedName = [Convert]::ToBase64String(
    [Text.Encoding]::UTF8.GetBytes($DisplayName)
)
$output = & ssh $SshHost sudo /opt/omen-irc/scripts/community-admin.sh `
    invite-member $encodedName
if ($LASTEXITCODE -ne 0) {
    throw "The AM4 invitation command failed."
}
$output
