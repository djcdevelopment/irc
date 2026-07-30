---
name: invite-irc-community
description: Create a single-use, 24-hour onboarding link for the AM4 IRC community. Use when Derek asks to invite, onboard, or generate a join link for a friend or community member.
---

# Invite an IRC community member

Use the protected administrator command already deployed in `C:\work\irc`.
The command keeps the registrar and portal tokens on AM4.

## Workflow

1. Use the friend's display name when supplied; otherwise use `Friend` without
   pausing to ask.
2. From `C:\work\irc`, run:

   ```powershell
   .\scripts\invite-community.ps1 -DisplayName "<display name>"
   ```

3. Return the URL and UTC expiry exactly as emitted.
4. Remind the administrator that the URL is single-use and should be sent
   privately to the intended recipient.

Do not open or redeem the link. Do not read, print, or copy the protected AM4
environment files.

If the command fails, verify read-only connectivity with `ssh am4 true`, then
run `ssh am4 sudo /opt/omen-irc/scripts/community-admin.sh status`. Report the
failing check without exposing credentials.
