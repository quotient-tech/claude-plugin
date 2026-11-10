---
name: list-fixes
description: List the frictions identified for you that still have a teammate's fix for you to apply, with each one's severity and how many of the fixes you've implemented, and pick one to work on.
disable-model-invocation: true
allowed-tools: mcp__plugin_quotient_agex__list_my_frictions, mcp__claude_ai_Quotient__list_my_frictions
---

# List fixes

## What the operator sees
- Never show the operator the id of a friction, a solution, a run or a session, even when a tool's reply holds one. Name a friction by its number or its description instead.
- Never show a teammate's name or email. Quotient never says who raised a friction or found a fix.
- Write no Insight, recap or other closing block, whatever your output style asks for.

## Steps

1. Before anything else, call `list_my_frictions` with `format: "table"`. Use Quotient's tools from one server for the whole skill: the `mcp__plugin_quotient_agex__` tools when you have them, and the `mcp__claude_ai_Quotient__` tools only when you don't.
   - If you have neither, you aren't signed in to Quotient. Say exactly this and stop, calling nothing else:

     > You're not signed in to Quotient.
     > - In Claude Code on your computer: run `/mcp`, select `plugin:quotient:agex`, and sign in.
     > - In a Claude Code cloud session: connect the Quotient connector at claude.ai/customize/connectors.
     >
     > Then try again.
   - If the tool returns an error, show its text exactly and stop: don't explain it, retry, or look for the cause.
2. If the reply starts with `No frictions with a solution from a teammate`, show it exactly as it is and stop.
3. If "Row ids" lists `none`, show nothing from the reply and go to step 4. Otherwise show the reply up to and not including "Row ids", exactly as it is apart from one change: leave out each numbered friction whose number isn't listed under "Row ids", since it has no teammate fix left to apply. Keep the numbers the table gives each friction; don't renumber. Never show the row ids. Don't add, reword, reorder or summarize anything else, and change nothing on disk.
4. If "Row ids" lists `none`, say none of your frictions has a teammate fix left to implement and that teammates' daily runs will keep looking, and stop. Otherwise ask: "Which friction do you want to work on? Reply with its number, or \"none\"."
   - "none": say nothing was changed, and stop.
   - A number listed under "Row ids": go to step 5 with that row's id.
   - A number that isn't under "Row ids": say that friction has no teammate fix to implement, and ask again, naming the numbers that can be picked.
   - Anything else: say which numbers can be picked, and ask again.
5. Invoke the `quotient:fix-friction` skill with the Skill tool, passing that row's id exactly, and nothing else. It shows the fixes found for that friction and asks which one to apply.
