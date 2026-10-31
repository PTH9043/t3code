import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";
import { connectDevelopmentEnvironment } from "./workspace-development-client.mjs";

const { values, positionals } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    home: { type: "string" },
    project: { type: "string" },
    recipe: { type: "string" },
    file: { type: "string" },
    url: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  process.stdout.write(
    "Usage:\n  node scripts/workspace-task-inbox.mjs list --home DATA_HOME --project PROJECT_ID\n  node scripts/workspace-task-inbox.mjs submit --home DATA_HOME --file task.json\n  node scripts/workspace-task-inbox.mjs github-issue --home DATA_HOME --project PROJECT_ID --recipe RECIPE_ID --url https://github.com/OWNER/REPO/issues/NUMBER\n",
  );
} else {
  let client;
  try {
    const mode = positionals[0];
    if (!values.home || !["list", "submit", "github-issue"].includes(mode))
      throw new Error("--home and list, submit or github-issue are required. Use --help.");
    let request;
    if (mode === "submit") {
      if (!values.file) throw new Error("--file is required.");
      request = JSON.parse(await NodeFSP.readFile(values.file, "utf8"));
    } else if (mode === "github-issue") {
      if (!values.project || !values.recipe || !values.url)
        throw new Error("--project, --recipe and --url are required.");
      const url = new URL(values.url);
      const match = /^\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)\/?$/.exec(url.pathname);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "github.com" ||
        url.username ||
        url.password ||
        !match
      )
        throw new Error("Expected a github.com HTTPS issue URL.");
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      const response = await fetch(
        `https://api.github.com/repos/${match[1]}/${match[2]}/issues/${match[3]}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2026-03-10",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok) throw new Error(`GitHub issue read failed: HTTP ${response.status}`);
      const issue = await response.json();
      if (
        issue.pull_request ||
        typeof issue.title !== "string" ||
        typeof issue.updated_at !== "string" ||
        typeof issue.html_url !== "string"
      )
        throw new Error("Response is not a supported issue.");
      const problem = `${issue.title}\n\n${issue.body ?? ""}`;
      if (problem.length > 4000)
        throw new Error(
          "Issue title and body exceed the task input limit of 4,000 characters. Submit a task JSON with a scoped problem and the original URL.",
        );
      request = {
        projectId: values.project,
        recipeId: values.recipe,
        source: "github",
        externalId: `${match[1]}/${match[2]}#${match[3]}:${issue.updated_at}`,
        inputs: { issueUrl: issue.html_url, problem },
      };
    } else if (!values.project) throw new Error("--project is required.");
    client = await connectDevelopmentEnvironment(values.home);
    if (mode === "list") {
      const overview = await client.rpc("workspaceTaskInbox.overview", {
        projectId: values.project,
      });
      process.stdout.write(
        JSON.stringify({
          recipes: overview.recipes.map(({ id, name, revision, enabled }) => ({
            id,
            name,
            revision,
            enabled,
          })),
          tasks: overview.tasks,
          totalTasks: overview.totalTasks,
          completed: overview.completed,
          aiSkipped: overview.aiSkipped,
        }) + "\n",
      );
    } else {
      const task = await client.rpc("workspaceTaskInbox.submit", request);
      process.stdout.write(
        JSON.stringify({
          id: task.id,
          status: task.status,
          recipeId: task.recipe.id,
          recipeRevision: task.recipe.revision,
          source: task.source,
          externalId: task.externalId,
        }) + "\n",
      );
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    client?.close();
  }
}
