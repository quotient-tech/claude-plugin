# Permissions

How quotient's calls to Quotient go through your Claude Code permission settings, which ones may ask you or be denied, and what you see when they are. For the short version, see [If Claude Code denies quotient's calls](../README.md#if-claude-code-denies-quotients-calls) in the README.

## Which calls quotient makes

Some of quotient's work runs outside any skill: the `/quotient:list-fixes` pane, recording a fix, the daily runs, the token usage it sends, the status line's count of frictions with a teammate's fix and the thank-yous teammates send you. Claude Code puts each of those calls to Quotient through your permission settings, like any tool call, and quotient approves none of them. Depending on your permission mode, Claude Code may ask you to allow a call or deny it.

## Background calls

Three kinds of call happen in the background, outside anything you do:

- the status line's count is read again every 15 minutes, after each answered turn and after `/quotient:list-fixes`, which calls `list_my_frictions`;
- new thank-yous are checked for at those same times, which calls `check_thank_yous`;
- the token usage is sent after each answered turn, which calls `record_usage`.

In auto mode they run. In the default and accept-edits modes Claude Code asks you to allow them, and in don't-ask mode they're denied. To have them, and the daily runs below, run without asking, add these rules to `~/.claude/settings.json`, merging them into any `permissions.allow` list you already have:

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_quotient_agex__list_my_frictions",
      "mcp__claude_ai_Quotient__list_my_frictions",
      "mcp__plugin_quotient_agex__record_usage",
      "mcp__claude_ai_Quotient__record_usage",
      "mcp__plugin_quotient_agex__claim_daily_run",
      "mcp__plugin_quotient_agex__complete_daily_run"
    ]
  }
}
```

The `plugin_quotient_agex` names are the plugin's own server and the `claude_ai_Quotient` names the claude.ai connector a cloud session uses. If you set up Quotient's server yourself under another name, use `mcp__<that name>__<tool>`. These rules let Claude, too, call the tool without asking: read your frictions, or send token usage to Quotient. Leave out the `record_usage` rules if you'd rather approve each send. Don't add a rule for `check_thank_yous`: each check marks the thank-yous it returns as delivered, so a check Claude made would use them up without showing them to you. Approve the check when Claude Code asks instead, or it waits for the next one. Don't add a rule for the whole server, such as `mcp__plugin_quotient_agex`: it would also let Claude send frictions, record fixes and send thank-yous without asking you.

The daily runs make two calls of their own when an interactive local session starts: `claim_daily_run` asks Quotient whether a run is due, and `complete_daily_run` marks a claimed run failed when it can't start. The last two rules in the block above let them start without asking. Cloud sessions start no daily runs, so these need no `claude_ai_Quotient` rules.

## When a call is denied

Your settings come first. An allow rule, ask rule or deny rule for one of these tools, a settings hook that asks or denies, plan mode, or a hook or policy your organization manages decides the call, and quotient doesn't change that. An ask rule asks you, as for any tool, and where nobody can answer, the call is denied. When a call is denied:

- the pane says Claude Code denied its call, and `/quotient:list-fixes` goes on to its skill, which can be denied too;
- recording a fix says the call was denied;
- the daily runs say they didn't start;
- usage, the status line and thank-yous say nothing, since they run in the background.

Each denial, with Claude Code's reason, is in the debug log (`claude --debug`), on a line starting `quotient`. A deny rule for one of these tools in your settings removes the tool, which reads as Quotient not being reachable rather than as a denial.

On a Team or Enterprise account, Claude Code may say at the start of a session that quotient's `tool.check` hook was skipped because `cc-plugin-sec-default` runs first. That notice alone doesn't mean a call was denied. A denied call shows one of the messages above, except the background ones, which show nothing and leave their reason in the debug log.
