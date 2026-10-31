try {
  const response = await fetch("http://127.0.0.1:8080/ready", { signal: AbortSignal.timeout(900) });
  const body = await response.json();
  if (
    response.status !== 200 ||
    body.type !== "bot.ready" ||
    body.contract !== 1 ||
    body.mode !== "simulation"
  ) {
    throw new Error(body.reason ?? "Readiness contract failed");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
