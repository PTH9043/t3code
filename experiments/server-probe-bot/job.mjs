export function validateJob(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a job object");
  }
  if (typeof value.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.id)) {
    throw new Error("Invalid job ID");
  }
  if (value.id.startsWith("scheduled-")) {
    throw new Error("Invalid job ID: reserved for scheduled work");
  }
  if (
    !Array.isArray(value.samples) ||
    value.samples.length === 0 ||
    value.samples.length > 64 ||
    value.samples.some((sample) => !Number.isSafeInteger(sample) || Math.abs(sample) > 1_000_000)
  ) {
    throw new Error("Expected 1 to 64 bounded integer samples");
  }
  return { id: value.id, samples: value.samples };
}

export function summarize(samples) {
  return {
    count: samples.length,
    sum: samples.reduce((sum, sample) => sum + sample, 0),
    min: Math.min(...samples),
    max: Math.max(...samples),
  };
}
