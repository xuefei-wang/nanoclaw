#!/usr/bin/env python3
"""
NanoClaw OpenAI Agent Runner

Runs inside a container, receives config via stdin, outputs result to stdout.
This mirrors the TypeScript agent-runner but uses OpenAI Agents SDK.

Input protocol:
    Stdin: Full ContainerInput JSON (read until EOF)

Output protocol:
    Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

OUTPUT_START_MARKER = "---NANOCLAW_OUTPUT_START---"
OUTPUT_END_MARKER = "---NANOCLAW_OUTPUT_END---"


@dataclass
class MemoryMcpConfig:
    """Memory MCP server configuration."""
    db_path: str = ""
    server_dir: str = ""
    snapshot_path: str = ""
    enable_specialty_query: bool = False
    enable_arc_tools: bool = False
    task_id: str = ""
    task_source: str = ""
    forum_generation: int = 0
    forum_round: int = 0
    forum_agent_id: str = ""
    forum_expected_agents: int = 0
    forum_task_ids: list[str] = field(default_factory=list)
    experiment: str = ""


@dataclass
class ContainerInput:
    """Input received from the host process via stdin."""
    prompt: str
    group_folder: str
    chat_jid: str = ""
    is_main: bool = False
    is_scheduled_task: bool = False
    session_id: str | None = None
    assistant_name: str | None = None
    secrets: dict[str, str] | None = None
    memory_mcp: MemoryMcpConfig | None = None


@dataclass
class ContainerOutput:
    """Output sent to the host process via stdout."""
    status: str  # "success" or "error"
    result: str | None
    error: str | None = None
    new_session_id: str | None = None
    tool_trace: list[dict[str, Any]] | None = None
    input_tokens: int = 0
    output_tokens: int = 0


def log(message: str) -> None:
    """Log to stderr (visible to host but not parsed as output)."""
    print(f"[openai-agent-runner] {message}", file=sys.stderr, flush=True)


def write_output(output: ContainerOutput) -> None:
    """Write output with markers for reliable parsing."""
    print(OUTPUT_START_MARKER, flush=True)
    print(
        json.dumps(
            {
                "status": output.status,
                "result": output.result,
                "error": output.error,
                "newSessionId": output.new_session_id,
                "toolTrace": output.tool_trace,
                "input_tokens": output.input_tokens,
                "output_tokens": output.output_tokens,
            }
        ),
        flush=True,
    )
    print(OUTPUT_END_MARKER, flush=True)


def parse_memory_mcp_config(data: dict[str, Any] | None) -> MemoryMcpConfig | None:
    """Parse memory MCP config from container input."""
    if not data:
        return None
    return MemoryMcpConfig(
        db_path=str(data.get("dbPath", "")),
        server_dir=str(data.get("serverDir", "")),
        snapshot_path=str(data.get("snapshotPath", "")),
        enable_specialty_query=bool(data.get("enableSpecialtyQuery", False)),
        enable_arc_tools=bool(data.get("enableArcTools", False)),
        task_id=str(data.get("taskId", "")),
        task_source=str(data.get("taskSource", "")),
        forum_generation=int(data.get("forumGeneration", 0) or 0),
        forum_round=int(data.get("forumRound", 0) or 0),
        forum_agent_id=str(data.get("forumAgentId", "")),
        forum_expected_agents=int(data.get("forumExpectedAgents", 0) or 0),
        forum_task_ids=list(data.get("forumTaskIds", []) or []),
        experiment=str(data.get("experiment", "")),
    )


def parse_input(raw: str) -> ContainerInput:
    """Parse JSON input from stdin."""
    data = json.loads(raw)
    return ContainerInput(
        prompt=str(data.get("prompt", "")),
        group_folder=str(data.get("groupFolder", "")),
        chat_jid=str(data.get("chatJid", "")),
        is_main=bool(data.get("isMain", False)),
        is_scheduled_task=bool(data.get("isScheduledTask", False)),
        session_id=data.get("sessionId"),
        assistant_name=data.get("assistantName"),
        secrets=data.get("secrets"),
        memory_mcp=parse_memory_mcp_config(data.get("memoryMcp")),
    )


def build_system_prompt(container_input: ContainerInput) -> str:
    """Build system prompt from workspace files."""
    parts: list[str] = []

    # Load global CLAUDE.md if exists
    global_claude_md = Path("/workspace/global/CLAUDE.md")
    if not container_input.is_main and global_claude_md.exists():
        parts.append(global_claude_md.read_text(encoding="utf-8", errors="replace"))

    # Load group CLAUDE.md if exists
    group_claude_md = Path("/workspace/group/CLAUDE.md")
    if group_claude_md.exists():
        parts.append(group_claude_md.read_text(encoding="utf-8", errors="replace"))

    # Load seed context if exists
    seed_context = Path("/workspace/group/.seed_context")
    if seed_context.exists():
        parts.append(seed_context.read_text(encoding="utf-8", errors="replace"))

    return "\n\n".join(parts) if parts else ""


def build_mcp_server_env(memory_mcp: MemoryMcpConfig) -> dict[str, str]:
    """Build environment variables for MCP server."""
    db_file = Path(memory_mcp.db_path).name if memory_mcp.db_path else ""
    snapshot_file = Path(memory_mcp.snapshot_path).name if memory_mcp.snapshot_path else ""
    task_source = memory_mcp.task_source.lower()
    toolset = "forum" if task_source == "forum_debate" else "task"

    return {
        "MEMORY_DB_PATH": f"/app/memory-db/{db_file}" if db_file else "",
        "MEMORY_SNAPSHOT_PATH": f"/app/memory-db/{snapshot_file}" if snapshot_file else "",
        "MEMORY_ENABLE_SPECIALTY_QUERY": "1" if memory_mcp.enable_specialty_query else "0",
        "MCP_TOOLSET": toolset,
        "FORUM_GENERATION": str(memory_mcp.forum_generation),
        "FORUM_ROUND": str(memory_mcp.forum_round),
        "FORUM_AGENT_ID": memory_mcp.forum_agent_id,
        "FORUM_EXPECTED_AGENTS": str(memory_mcp.forum_expected_agents),
        "FORUM_TASK_IDS": ",".join(memory_mcp.forum_task_ids),
        "MEMORY_EXPERIMENT": memory_mcp.experiment,
    }


def extract_token_usage(result: Any) -> tuple[int, int]:
    """Extract input and output token counts from agent result."""
    input_tokens = 0
    output_tokens = 0
    for response in getattr(result, "raw_responses", []) or []:
        usage = getattr(response, "usage", None)
        if not usage:
            continue
        input_tokens += int(getattr(usage, "input_tokens", 0) or 0)
        output_tokens += int(getattr(usage, "output_tokens", 0) or 0)
    return input_tokens, output_tokens


def extract_tool_trace(result: Any) -> list[dict[str, Any]]:
    """Extract tool call trace from agent result."""
    tool_trace: list[dict[str, Any]] = []

    for item in getattr(result, "new_items", []) or []:
        item_type = getattr(item, "type", None)
        if item_type == "tool_call_item":
            raw_item = getattr(item, "raw_item", None) or {}
            if isinstance(raw_item, dict):
                name = raw_item.get("name", "unknown")
                tool_input = raw_item.get("arguments") or raw_item.get("input", {})
            else:
                name = getattr(raw_item, "name", None) or "unknown"
                tool_input = getattr(raw_item, "arguments", None) or getattr(raw_item, "input", {})

            if isinstance(tool_input, str):
                try:
                    tool_input = json.loads(tool_input)
                except json.JSONDecodeError:
                    tool_input = {"raw": tool_input}

            tool_trace.append({
                "type": "tool_call",
                "tool_name": name,
                "tool_input": tool_input,
            })

    return tool_trace


async def run_agent(container_input: ContainerInput) -> ContainerOutput:
    """Run the OpenAI agent with MCP server support."""
    try:
        from agents import Agent, Runner
        from agents.mcp import MCPServerStdio
    except ImportError as exc:
        return ContainerOutput(
            status="error",
            result=None,
            error=f"openai-agents package not installed: {exc}",
        )

    # Set up API key from secrets
    if container_input.secrets:
        api_key = container_input.secrets.get("OPENAI_API_KEY", "")
        if api_key:
            os.environ["OPENAI_API_KEY"] = api_key

    # Get model from environment
    model = os.environ.get("MODEL", "gpt-4.1-mini")
    log(f"Using model: {model}")

    # Build system prompt
    system_prompt = build_system_prompt(container_input)

    # Build prompt with automated task prefix if needed
    prompt = container_input.prompt
    if container_input.is_scheduled_task:
        prompt = f"[AUTOMATED TASK - This task was dispatched programmatically by the orchestrator.]\n\n{prompt}"

    # Configure MCP servers
    mcp_servers = []

    # Memory MCP server
    if container_input.memory_mcp and Path("/app/memory/mcp_server.py").exists():
        memory_env = build_mcp_server_env(container_input.memory_mcp)
        log(f"Registering memory MCP server with toolset={memory_env['MCP_TOOLSET']}")

        memory_server = MCPServerStdio(
            name="memory",
            params={
                "command": "python3",
                "args": ["/app/memory/mcp_server.py"],
                "env": memory_env,
            },
        )
        mcp_servers.append(memory_server)

        # ARC MCP server for ARC tasks
        task_source = container_input.memory_mcp.task_source.lower()
        if task_source == "arc" and container_input.memory_mcp.enable_arc_tools:
            arc_env = {
                **memory_env,
                "MCP_TOOLSET": "arc",
                "ARC_TASK_ID": container_input.memory_mcp.task_id,
            }
            arc_server = MCPServerStdio(
                name="arc",
                params={
                    "command": "python3",
                    "args": ["/app/memory/mcp_server.py"],
                    "env": arc_env,
                },
            )
            mcp_servers.append(arc_server)
            log("Registered ARC MCP server")

    try:
        # Use async context managers for MCP servers
        async with asyncio.TaskGroup() as tg:
            server_contexts = []
            for server in mcp_servers:
                ctx = await server.__aenter__()
                server_contexts.append((server, ctx))

        # Create agent with MCP servers (empty list if no servers configured)
        agent = Agent(
            name="NanoClawOpenAIAgent",
            instructions=system_prompt,
            model=model,
            mcp_servers=[s for s, _ in server_contexts] if server_contexts else [],
        )

        # Run the agent
        log(f"Running agent with prompt ({len(prompt)} chars)")
        result = await Runner.run(agent, prompt)

        # Extract results
        input_tokens, output_tokens = extract_token_usage(result)
        tool_trace = extract_tool_trace(result)
        final_output = getattr(result, "final_output", "") or ""

        # Clean up MCP servers
        for server, _ in server_contexts:
            await server.__aexit__(None, None, None)

        return ContainerOutput(
            status="success",
            result=final_output,
            tool_trace=tool_trace,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )

    except asyncio.TimeoutError:
        return ContainerOutput(
            status="error",
            result=None,
            error="Agent timed out",
        )
    except Exception as e:
        log(f"Agent error: {e}")
        return ContainerOutput(
            status="error",
            result=None,
            error=str(e),
        )


async def main() -> None:
    """Main entry point."""
    log("Starting OpenAI agent runner")

    # Read input from stdin
    raw_input = sys.stdin.read()

    # Delete temp file (same as TypeScript runner)
    try:
        Path("/tmp/input.json").unlink()
    except FileNotFoundError:
        pass

    if not raw_input.strip():
        write_output(
            ContainerOutput(
                status="error",
                result=None,
                error="No input received on stdin",
            )
        )
        return

    try:
        container_input = parse_input(raw_input)
        log(f"Received input for group: {container_input.group_folder}")
    except json.JSONDecodeError as e:
        write_output(
            ContainerOutput(
                status="error",
                result=None,
                error=f"Invalid JSON input: {e}",
            )
        )
        return

    output = await run_agent(container_input)
    write_output(output)
    log("Agent runner complete")


if __name__ == "__main__":
    asyncio.run(main())
