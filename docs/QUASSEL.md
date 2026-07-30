# Quassel client setup

## Use the correct Quassel application

Use **Quassel Monolithic / Standalone**, not the executable or macOS package
named only **Quassel Client**.

Quassel Client speaks the Quassel client/core protocol and requires a separate
Quassel Core. The monolithic application contains its own local component and
connects directly to Ergo. This deployment does not run Quassel Core.

## Exact connection values

| Field | Value |
|---|---|
| Network name | `Omen IRC` |
| Server | `am4.tail8e749c.ts.net` |
| Port | `8443` |
| TLS/SSL | On |
| Verify connection security | On |
| Server password | Blank |
| Nickname | Your Ergo account name |
| Username/ident | Your Ergo account name |
| Real name | Your preferred display name |
| SASL | Enabled |
| SASL mechanism | PLAIN |
| SASL account | Your Ergo account name |
| SASL password | Your personal Ergo account password |
| Automatic joins | `#general`, `#ops` |
| Automatic reconnect | On; 10 seconds; unlimited retries |

Tailscale Funnel supplies a publicly trusted certificate for
`am4.tail8e749c.ts.net`. Do not disable verification and do not install the old
OMEN self-signed certificate. Users do not need Tailscale.

The initial administrator account is `admin`. Its password exists only in the
operator's protected secret files. Every other person should receive a distinct
Ergo account and password through a trusted channel.

## Windows

1. Install the official 64-bit Quassel bundle.
2. Launch **Quassel**, not **Quassel Client** or **Quassel Core**.
3. Complete the local/monolithic first-run wizard.
4. Open **Settings → Configure Quassel → Identities**.
5. Set nickname and username to the assigned Ergo account. Set the preferred
   real name.
6. Open **Settings → Configure Quassel → Networks** and add `Omen IRC`.
7. On **Servers**, add `am4.tail8e749c.ts.net`, port `8443`.
8. Enable **Use encrypted connection** and **Verify connection security**.
   Leave the server password blank.
9. On **Auto Identify**, enable **Use SASL Authentication**. Enter the Ergo
   account and personal password. Leave legacy NickServ Auto Identify off.
10. On **Connection**, enable automatic reconnect, a 10-second retry delay, and
    unlimited retries. Enable rejoin after reconnect.
11. Add `/JOIN #general` and `/JOIN #ops` under connect commands, or mark both
    channels for automatic join after joining once.
12. Delete or disable the old `omen...:6697` and `127.0.0.1:6697` entries so
    Quassel cannot cycle into the retained rollback server.
13. Apply and connect.

## macOS

1. Install the official **macOS Monolithic Client (all-in-one/standalone)**.
2. Launch Quassel and choose its local/monolithic mode; do not configure a
   remote core.
3. Create an identity with the Ergo account as nickname and username and set
   the preferred real name.
4. Add network `Omen IRC`.
5. Add `am4.tail8e749c.ts.net`, port `8443`, with TLS and certificate
   verification enabled.
6. Enable SASL PLAIN and save the personal account and password.
7. Enable automatic reconnect and automatic joins for `#general` and `#ops`.
8. Remove the old OMEN 6697 server entry if it was copied from Windows.
9. Connect. The certificate should validate normally without a prompt.

## Account initialization

Run these once after the first authenticated connection:

```text
/NS SET MULTICLIENT ON
/NS SET ALWAYS-ON TRUE
/NS SET AUTOREPLAY-MISSED ON
/NS SET AUTOREPLAY-LINES 100
/NS SET DM-HISTORY ON
/NS SET AUTO-AWAY ON
```

Bootstrap already applied them to `admin`.

## Multiple Quassel installations

Configure every Quassel Monolithic installation with the same Ergo account,
nickname, and SASL credentials. Ergo authenticates the sessions and attaches
both to the same always-on identity. Both clients can remain online without a
nickname collision and receive the same live traffic.

Each Quassel installation still has its own local UI settings and local
database. Ergo is authoritative for the shared account, channel ownership, and
30-day server history.

## History and multi-client acceptance test

1. Connect and confirm SASL succeeds.
2. Join `#general` and `#ops`.
3. Send several unique messages to `#general`.
4. Fully disconnect or close Quassel.
5. Send another message from The Lounge or a second authenticated client.
6. Reconnect with the same account and confirm the missed message is replayed.
7. Connect a second Quassel installation with the same account and confirm both
   remain online with the same nickname.
8. Ask the operator to restart the AM4 stack.
9. Reconnect and confirm the account, channels, and history remain.

## Troubleshooting

### Connection refused

- Confirm the server is exactly `am4.tail8e749c.ts.net`, port `8443`.
- Confirm TLS is enabled.
- On Windows run:

  ```powershell
  Test-NetConnection am4.tail8e749c.ts.net -Port 8443
  ```

- The operator should run
  `sudo /opt/omen-irc/scripts/check-am4.sh --require-funnel`.

### TLS certificate errors

The expected certificate name is `am4.tail8e749c.ts.net`, issued by a public
certificate authority. Check the computer clock, exact hostname, and TLS
setting. Remove any old per-server self-signed exception. Do not fix this by
disabling certificate verification.

### SASL authentication failure

- Account and password input are case-sensitive.
- The nickname must match the account under the network's strict policy.
- Confirm **Use SASL Authentication** is enabled; legacy NickServ Auto Identify
  is not a substitute.
- Ask the operator to confirm `/NS INFO account`.
- After repeated failures, wait one minute for login throttling.

### Nickname already in use

SASL must finish before registration completes. Confirm the nickname exactly
matches the SASL account, then run `/NS SET MULTICLIENT ON` once. Do not add
random underscores to work around a failed login.

### No history after reconnect

Run:

```text
/NS GET ALWAYS-ON
/NS GET AUTOREPLAY-MISSED
/NS SET ALWAYS-ON TRUE
/NS SET AUTOREPLAY-MISSED ON
/NS SET AUTOREPLAY-LINES 100
```

Confirm `/CS INFO #general` says the channel is registered. Persistent channel
history is mandatory for registered channels and intentionally disabled for
unregistered channels.

### Windows Firewall blocking the port

Quassel needs an outbound TCP connection to 8443; it does not need a Windows
inbound rule. Confirm the current network permits outbound 8443 and that
endpoint-security software is not intercepting TLS. Test with
`Test-NetConnection` as shown above.

### Tailscale DNS name not resolving

The `.ts.net` hostname is also public for Funnel and does not require the
Tailscale client. Test:

```powershell
Resolve-DnsName am4.tail8e749c.ts.net
```

Flush a stale resolver with `Clear-DnsClientCache`, try another network, and
confirm no DNS filter blocks `.ts.net`. Do not replace the hostname with an IP:
TLS verification and Funnel routing require the hostname.
