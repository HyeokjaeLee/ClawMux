import { describe, test, expect, beforeEach, beforeAll } from "bun:test";
import { classifyLocal, resetClassifier } from "../routing/local-classifier.ts";
import type { Message } from "../routing/types.ts";

const RUNS_PER_CASE = 5;
const MIN_CONSISTENT = 5;

function makeMessages(userText: string): ReadonlyArray<Message> {
  return [{ role: "user", content: userText }];
}

async function classifyNTimes(userText: string, n: number): Promise<string[]> {
  const messages = makeMessages(userText);
  const results: string[] = [];
  for (let i = 0; i < n; i++) {
    const result = await classifyLocal(messages);
    results.push(result.tier);
  }
  return results;
}

async function classifyWithContextNTimes(
  messages: ReadonlyArray<Message>,
  n: number,
): Promise<string[]> {
  const results: string[] = [];
  for (let i = 0; i < n; i++) {
    const result = await classifyLocal(messages);
    results.push(result.tier);
  }
  return results;
}

function countMatches(results: string[], expected: string): number {
  return results.filter((r) => r === expected).length;
}

const REFACTOR_CODE = [
  "이 함수를 리팩토링해줘:",
  "function processUsers(data) {",
  "  var result = [];",
  "  for (var i = 0; i < data.length; i++) {",
  "    if (data[i].active == true && data[i].age > 18) {",
  "      var name = data[i].firstName + ' ' + data[i].lastName;",
  "      var obj = { name: name, email: data[i].email, role: data[i].isAdmin ? 'admin' : 'user' };",
  "      if (data[i].department !== null && data[i].department !== undefined) {",
  "        obj.department = data[i].department.name;",
  "        obj.manager = data[i].department.manager ? data[i].department.manager.name : 'N/A';",
  "      }",
  "      result.push(obj);",
  "    }",
  "  }",
  "  result.sort(function(a, b) { return a.name > b.name ? 1 : -1; });",
  "  return result;",
  "}",
].join("\n");

beforeAll(async () => {
  // Pre-warm: trigger lazy model loading so tests don't each wait for it
  await classifyLocal([{ role: "user", content: "warmup" }]);
}, 180_000);

beforeEach(() => {
  resetClassifier();
});

describe("Local Classifier", () => {
  test("LIGHT: Korean greeting -> LIGHT", async () => {
    const results = await classifyNTimes("안녕하세요", RUNS_PER_CASE);
    const matches = countMatches(results, "LIGHT");
    expect(matches).toBeGreaterThanOrEqual(MIN_CONSISTENT);
  }, 120_000);

  test("LIGHT: thanks -> LIGHT", async () => {
    const results = await classifyNTimes("고마워", RUNS_PER_CASE);
    const matches = countMatches(results, "LIGHT");
    expect(matches).toBeGreaterThanOrEqual(MIN_CONSISTENT);
  }, 120_000);

  test("LIGHT: simple yes -> LIGHT", async () => {
    const results = await classifyNTimes("네", RUNS_PER_CASE);
    const matches = countMatches(results, "LIGHT");
    expect(matches).toBeGreaterThanOrEqual(MIN_CONSISTENT);
  }, 120_000);

  test("LIGHT: simple factual question -> LIGHT", async () => {
    const results = await classifyNTimes("Python이 뭐야?", RUNS_PER_CASE);
    const matches = countMatches(results, "LIGHT");
    expect(matches).toBeGreaterThanOrEqual(MIN_CONSISTENT);
  }, 120_000);

  test("MEDIUM: coding task -> MEDIUM", async () => {
    const results = await classifyNTimes(
      "Write a quicksort function in TypeScript",
      RUNS_PER_CASE,
    );
    const matches = countMatches(results, "MEDIUM");
    expect(matches).toBeGreaterThanOrEqual(MIN_CONSISTENT);
  }, 120_000);

  test("MEDIUM: API endpoint task -> MEDIUM", async () => {
    const results = await classifyNTimes(
      "REST API에 로그인 엔드포인트 추가해줘",
      RUNS_PER_CASE,
    );
    const matches = countMatches(results, "MEDIUM");
    expect(matches).toBeGreaterThanOrEqual(MIN_CONSISTENT);
  }, 120_000);

  test("MEDIUM: refactor complex function -> MEDIUM", async () => {
    const results = await classifyNTimes(REFACTOR_CODE, RUNS_PER_CASE);
    const matches = countMatches(results, "MEDIUM");
    expect(matches).toBeGreaterThanOrEqual(MIN_CONSISTENT);
  }, 120_000);

  test("HEAVY: distributed system architecture -> HEAVY", async () => {
    const results = await classifyNTimes(
      "Design a distributed consensus algorithm for a multi-region database with strong consistency and Byzantine fault tolerance",
      RUNS_PER_CASE,
    );
    const matches = countMatches(results, "HEAVY");
    expect(matches).toBeGreaterThanOrEqual(MIN_CONSISTENT);
  }, 120_000);

  test("HEAVY: complex debugging -> HEAVY", async () => {
    const heavyDebugText = "메모리 릭이 발생하는데 프로파일러에서 이벤트 루프 블로킹과 GC 지연이 동시에 나타나. 마이크로서비스 간 gRPC 연결 풀링도 의심되는 상황인데 원인 분석 방법을 단계별로 설명해줘";
    const results = await classifyNTimes(heavyDebugText, RUNS_PER_CASE);
    const matches = countMatches(results, "HEAVY");
    expect(matches).toBeGreaterThanOrEqual(MIN_CONSISTENT);
  }, 120_000);

  test("NEEDS_CONTEXT: ambiguous pronoun reference -> re-classified to L/M/H", async () => {
    const messages: ReadonlyArray<Message> = [
      { role: "user", content: "아까 그거 다시 해줘" },
    ];
    const results = await classifyWithContextNTimes(messages, RUNS_PER_CASE);
    const validCount = results.filter((r) => ["LIGHT", "MEDIUM", "HEAVY"].includes(r)).length;
    expect(validCount).toBeGreaterThanOrEqual(MIN_CONSISTENT);
  }, 120_000);

  test("re-classification: context provided -> L (never Q)", async () => {
    const messages: ReadonlyArray<Message> = [
      { role: "user", content: "분산 시스템 아키텍처 설계를 논의하고 있었어" },
      { role: "assistant", content: "네, CQRS 패턴과 이벤트 소싱에 대해 이야기하고 있었습니다." },
      { role: "user", content: "고마워" },
    ];
    const results = await classifyWithContextNTimes(messages, RUNS_PER_CASE);
    const validCount = results.filter((r) => ["LIGHT", "MEDIUM", "HEAVY"].includes(r)).length;
    expect(validCount).toBeGreaterThanOrEqual(MIN_CONSISTENT);
  }, 120_000);
});
