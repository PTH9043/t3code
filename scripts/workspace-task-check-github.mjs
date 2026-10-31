// A read-only precheck example. Run from an automation recipe with a repository input (OWNER/REPO).
const inputs = JSON.parse(process.env.T3_TASK_INPUTS_JSON || "{}");
const repository = inputs.repository;
if (typeof repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repository))
  throw new Error("A repository input in OWNER/REPO form is required.");
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const response = await fetch(`https://api.github.com/repos/${repository}/commits?per_page=1`, {
  headers: {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2026-03-10",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  signal: AbortSignal.timeout(15000),
});
if (!response.ok) throw new Error(`GitHub commit read failed: HTTP ${response.status}`);
const commits = await response.json();
const commit = commits[0];
if (!commit || typeof commit.sha !== "string" || typeof commit.html_url !== "string")
  throw new Error("GitHub did not return a commit.");
const fingerprint = commit.sha;
const previous = process.env.T3_TASK_PREVIOUS_FINGERPRINT;
process.stdout.write(
  JSON.stringify({
    changed: true,
    fingerprint,
    context: `${repository}\n현재 커밋: ${commit.html_url}\n이전 완료 커밋: ${previous || "첫 실행"}\n${String(commit.commit?.message || "").slice(0, 1000)}`,
  }) + "\n",
);
