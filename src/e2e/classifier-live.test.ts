import { describe, test, expect } from "bun:test";

const ZAI_API_KEY = process.env.ZAI_API_KEY;
const describeIf = ZAI_API_KEY ? describe : describe.skip;

const ZAI_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const CLASSIFIER_MODEL = "glm-4.5-air";
const MAX_TOKENS = 1000;
const RUNS_PER_CASE = 5;
const MIN_CONSISTENT = 5;

const CLASSIFICATION_SYSTEM_PROMPT =
  "Classify complexity. Reply with exactly one character.\n" +
  "L - simple: greeting, confirmation, short factual answer, single lookup\n" +
  "M - moderate: standard coding, explanation, straightforward multi-step\n" +
  "H - complex: deep reasoning, architecture, complex debugging, multi-domain\n" +
  "Q - unclear without conversation context, need prior messages to judge";

const RECLASSIFICATION_SYSTEM_PROMPT =
  "Classify complexity. Reply with exactly one character.\n" +
  "L - simple: greeting, confirmation, short factual answer, single lookup\n" +
  "M - moderate: standard coding, explanation, straightforward multi-step\n" +
  "H - complex: deep reasoning, architecture, complex debugging, multi-domain";

interface ChatCompletionResponse {
  choices: Array<{
    message: { content: string; reasoning_content?: string };
  }>;
}

async function callClassifier(
  messages: Array<{ role: string; content: string }>,
  systemPrompt: string,
): Promise<string> {
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const resp = await fetch(`${ZAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ZAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "system", content: systemPrompt }, ...messages],
      }),
    });

    if (resp.ok) {
      const json = (await resp.json()) as ChatCompletionResponse;
      const content = json.choices[0]?.message?.content?.trim();
      if (content) return content;
    }

    if (attempt < maxRetries - 1) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw new Error("z.ai API failed after retries");
}

async function classifyNTimes(
  userMessage: string,
  n: number,
  systemPrompt = CLASSIFICATION_SYSTEM_PROMPT,
): Promise<string[]> {
  const promises = Array.from({ length: n }, (_, i) =>
    new Promise<string>((resolve) => setTimeout(resolve, i * 500)).then(() =>
      callClassifier([{ role: "user", content: userMessage }], systemPrompt),
    ),
  );
  return Promise.all(promises);
}

async function classifyWithContextNTimes(
  messages: Array<{ role: string; content: string }>,
  n: number,
  systemPrompt = CLASSIFICATION_SYSTEM_PROMPT,
): Promise<string[]> {
  const promises = Array.from({ length: n }, (_, i) =>
    new Promise<string>((resolve) => setTimeout(resolve, i * 500)).then(() =>
      callClassifier(messages, systemPrompt),
    ),
  );
  return Promise.all(promises);
}

function countMatches(results: string[], expected: string): number {
  return results.filter((r) => r === expected).length;
}

function formatResults(results: string[], expected: string): string {
  const counts: Record<string, number> = {};
  for (const r of results) {
    counts[r] = (counts[r] ?? 0) + 1;
  }
  const dist = Object.entries(counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return `expected=${expected} results=[${dist}] (${results.join(",")})`;
}

const REFACTOR_CODE = `이 함수를 리팩토링해줘:
function processUsers(data) {
  var result = [];
  for (var i = 0; i < data.length; i++) {
    if (data[i].active == true && data[i].age > 18) {
      var name = data[i].firstName + ' ' + data[i].lastName;
      var obj = { name: name, email: data[i].email, role: data[i].isAdmin ? 'admin' : 'user' };
      if (data[i].department !== null && data[i].department !== undefined) {
        obj.department = data[i].department.name;
        obj.manager = data[i].department.manager ? data[i].department.manager.name : 'N/A';
      }
      result.push(obj);
    }
  }
  result.sort(function(a, b) { return a.name > b.name ? 1 : -1; });
  return result;
}`;

const TIMEOUT = 120_000;

describeIf("LLM Classifier — Live z.ai API", () => {
  test("LIGHT: Korean greeting -> L", async () => {
    const results = await classifyNTimes("안녕하세요", RUNS_PER_CASE);
    const matches = countMatches(results, "L");
    expect(matches).toBeGreaterThanOrEqual(MIN_CONSISTENT);
  }, TIMEOUT);

  test("LIGHT: thanks -> L", async () => {
    const results = await classifyNTimes("고마워", RUNS_PER_CASE);
    const matches = countMatches(results, "L");
    expect(matches).toBeGreaterThanOrEqual(MIN_CONSISTENT);
  }, TIMEOUT);

  test("LIGHT: simple yes -> L", async () => {
    const results = await classifyNTimes("네", RUNS_PER_CASE);
    const matches = countMatches(results, "L");
    expect(matches).toBeGreaterThanOrEqual(MIN_CONSISTENT);
  }, TIMEOUT);

  test("LIGHT: simple factual question -> L", async () => {
    const results = await classifyNTimes("Python이 뭐야?", RUNS_PER_CASE);
    const matches = countMatches(results, "L");
    expect(matches).toBeGreaterThanOrEqual(MIN_CONSISTENT);
  }, TIMEOUT);

  test("MEDIUM: coding task -> M", async () => {
    const results = await classifyNTimes(
      "Write a quicksort function in TypeScript",
      RUNS_PER_CASE,
    );
    const matches = countMatches(results, "M");
    expect(matches).toBeGreaterThanOrEqual(MIN_CONSISTENT);
  }, TIMEOUT);

  test("MEDIUM: API endpoint task -> M", async () => {
    const results = await classifyNTimes(
      "REST API에 로그인 엔드포인트 추가해줘",
      RUNS_PER_CASE,
    );
    const matches = countMatches(results, "M");
    expect(matches).toBeGreaterThanOrEqual(MIN_CONSISTENT);
  }, TIMEOUT);

  test("MEDIUM: refactor complex function -> M", async () => {
    const results = await classifyNTimes(REFACTOR_CODE, RUNS_PER_CASE);
    const matches = countMatches(results, "M");
    expect(matches).toBeGreaterThanOrEqual(MIN_CONSISTENT);
  }, TIMEOUT);

  test("HEAVY: distributed system architecture -> H", async () => {
    const results = await classifyNTimes(
      "Design a distributed consensus algorithm for a multi-region database with strong consistency and Byzantine fault tolerance",
      RUNS_PER_CASE,
    );
    const matches = countMatches(results, "H");
    expect(matches).toBeGreaterThanOrEqual(MIN_CONSISTENT);
  }, TIMEOUT);

  test("HEAVY: complex debugging -> H", async () => {
    const results = await classifyNTimes(
      "메모리 릭이 발생하는데 프로파일러에서 이벤트 루프 블로킹과 GC 지연이 동시에 나타나. 마이크로서비스 간 gRPC 연결 풀링도 의심되는 상황인데 원인 분석 방법을 단계별로 설명해줘",
      RUNS_PER_CASE,
    );
    const matches = countMatches(results, "H");
    expect(matches).toBeGreaterThanOrEqual(MIN_CONSISTENT);
  }, TIMEOUT);

  test("NEEDS_CONTEXT: ambiguous pronoun reference -> Q", async () => {
    const results = await classifyNTimes("아까 그거 다시 해줘", RUNS_PER_CASE);
    const matches = countMatches(results, "Q");
    expect(matches).toBeGreaterThanOrEqual(MIN_CONSISTENT);
  }, TIMEOUT);

  test("re-classification: context provided -> L, M, or H (never Q)", async () => {
    const results = await classifyWithContextNTimes(
      [
        { role: "user", content: "분산 시스템 아키텍처 설계를 논의하고 있었어" },
        { role: "assistant", content: "네, CQRS 패턴과 이벤트 소싱에 대해 이야기하고 있었습니다." },
        { role: "user", content: "고마워" },
      ],
      RUNS_PER_CASE,
      RECLASSIFICATION_SYSTEM_PROMPT,
    );
    const validCount = results.filter((r) => ["L", "M", "H"].includes(r)).length;
    expect(validCount).toBeGreaterThanOrEqual(MIN_CONSISTENT);
  }, TIMEOUT);
});
