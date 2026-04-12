import { pipeline, Tensor } from "@huggingface/transformers";
import type { ClassificationResult, ClassificationTier, Message } from "./types.ts";

const CAT_L = "L";
const CAT_M = "M";
const CAT_H = "H";
const CAT_Q = "Q";

const TIER_MAP: Record<string, ClassificationTier> = {
  L: "LIGHT",
  M: "MEDIUM",
  H: "HEAVY",
};

const MODEL_ID = "Xenova/multilingual-e5-small";
const E5_PREFIX = "query: ";
const BATCH_SIZE = 32;

const TRAINING_LIGHT: string[] = [
  "안녕하세요", "안녕", "안녕히 가세요", "안녕히 계세요", "반갑습니다",
  "잘 지내시죠", "오랜만이에요",
  "고마워", "감사합니다", "고맙습니다", "네 고마워요", "정말 감사합니다", "도와줘서 고마워",
  "네", "예", "아니요", "좋아요", "알겠습니다", "확인했습니다", "그래요", "맞아요", "아 네",
  "Python이 뭐야?", "JavaScript가 뭐야?", "오늘 날씨 어때?", "지금 몇 시야?",
  "이거 뭐야?", "TypeScript가 뭐예요?", "API가 뭐야?", "HTML이 뭐야?", "CSS가 뭐야?",
  "Hello", "Hi", "Hey there", "Good morning", "Good afternoon", "How are you", "What's up",
  "Thanks", "Thank you", "Got it", "OK", "Sounds good", "I see", "Understood", "Great thanks",
  "What is Python?", "What time is it?", "What's the weather?", "Who is Einstein?",
  "Where is Seoul?", "How old are you?",
  "yes", "no", "maybe", "sure", "please", "done", "ok", "cool", "nice", "awesome",
];

const TRAINING_MEDIUM: string[] = [
  "Write a quicksort function in TypeScript",
  "Implement a binary search tree with insert and delete",
  "Create a REST API endpoint for user authentication",
  "Write a function to merge two sorted arrays",
  "Implement a linked list in Python",
  "Write a unit test for the calculator module",
  "Create a simple Express.js middleware for logging",
  "Write a regex to validate email addresses",
  "Implement a LRU cache with get and put operations",
  "Create a React component for a todo list",
  "Write a SQL query to join two tables",
  "Implement a basic JWT authentication flow",
  "Write a function to parse CSV files",
  "Create a simple WebSocket server",
  "Implement bubble sort in Java",
  "Write a Python script to read a JSON file",
  "Create a Docker compose file for a web app",
  "Write a Git pre-commit hook",
  "REST API에 로그인 엔드포인트 추가해줘",
  "이 함수에 에러 핸들링 추가해줘",
  "TypeScript로 이벤트 이미터 만들어줘",
  "데이터베이스 마이그레이션 스크립트 작성해줘",
  "React 컴포넌트에 상태 관리 추가해줘",
  "Express 라우터에 CORS 미들웨어 추가해줘",
  "테스트 코드 작성해줘",
  "이 코드 리팩토링해줘",
  "Explain the difference between let and const in JavaScript",
  "What's the difference between SQL and NoSQL databases",
  "Explain how async await works in Python",
  "Describe the MVC architecture pattern",
  "Explain what Docker containers are",
  "REST와 GraphQL의 차이점을 설명해줘",
  "이벤트 루프가 어떻게 동작하는지 설명해줘",
  "클로저가 뭐야? 설명해줘",
  "Set up a Node.js project with TypeScript and ESLint",
  "Create a basic CI/CD pipeline using GitHub Actions",
  "Configure Nginx as a reverse proxy for a Node.js app",
  "이 함수를 리팩토링해줘:\nfunction processUsers(data) {\n  var result = [];\n  for (var i = 0; i < data.length; i++) {\n    if (data[i].active == true && data[i].age > 18) {\n      var name = data[i].firstName + ' ' + data[i].lastName;\n      var obj = { name: name, email: data[i].email, role: data[i].isAdmin ? 'admin' : 'user' };\n      if (data[i].department !== null && data[i].department !== undefined) {\n        obj.department = data[i].department.name;\n        obj.manager = data[i].department.manager ? data[i].department.manager.name : 'N/A';\n      }\n      result.push(obj);\n    }\n  }\n  result.sort(function(a, b) { return a.name > b.name ? 1 : -1; });\n  return result;\n}",
  "Refactor this code to use modern JavaScript:\nfunction getItems(list) {\n  var items = [];\n  for (var i = 0; i < list.length; i++) {\n    if (list[i].active === true) {\n      items.push(list[i].name);\n    }\n  }\n  return items;\n}",
];

const TRAINING_HEAVY: string[] = [
  "Design a distributed consensus algorithm for a multi-region database with strong consistency and Byzantine fault tolerance",
  "Explain the theoretical foundations of quantum computing and how quantum entanglement can be used for cryptographic key distribution",
  "Analyze the trade-offs between eventual consistency and strong consistency in distributed systems, including CAP theorem implications",
  "Design a fault-tolerant microservices architecture for a real-time trading platform handling millions of transactions per second",
  "Propose a novel approach to solving the traveling salesman problem that improves upon current approximation algorithms",
  "Design a machine learning pipeline for real-time fraud detection in financial transactions with sub-millisecond latency requirements",
  "Compare and contrast different consensus protocols (Paxos, Raft, PBFT) and recommend the best one for a blockchain-based supply chain system",
  "Architect a system that can handle 10 million concurrent WebSocket connections with horizontal scaling",
  "Design a real-time data streaming architecture combining Kafka, Flink, and a time-series database for IoT sensor data",
  "메모리 릭이 발생하는데 프로파일러에서 이벤트 루프 블로킹과 GC 지연이 동시에 나타나. 마이크로서비스 간 gRPC 연결 풀링도 의심되는 상황인데 원인 분석 방법을 단계별로 설명해줘",
  "대규모 분산 시스템에서 파티션 톨런스와 일관성을 동시에 보장하는 방법을 설계해줘",
  "실시간 추천 시스템을 위한 아키텍처를 설계해줘. 1초 이내에 개인화된 추천을 제공해야 해",
  "카프카 기반 이벤트 드리븐 아키텍처에서 순서 보장과 정확히 한 번 처리를 어떻게 보장할 수 있을까?",
  "마이크로서비스 간의 분산 트랜잭션을 사가 패턴으로 구현하는 방법을 단계별로 설명해줘",
  "Debug a memory leak in a production Node.js application where the heap grows indefinitely but garbage collection logs show normal behavior",
  "Investigate why our Kubernetes pods are being OOMKilled despite having memory limits set to 4GB and actual usage reported as 2GB",
  "Find the root cause of intermittent 500ms latency spikes in our PostgreSQL queries that happen every 15 minutes",
  "Design a multi-tenant SaaS platform with shared infrastructure but isolated data, supporting custom domains and white-labeling",
  "Implement a distributed task scheduler that guarantees at-least-once execution with idempotency support across multiple data centers",
];

const TRAINING_Q: string[] = [
  "아까 그거 다시 해줘", "그거 좀 더 자세히 설명해줘", "아까 말한 거 그대로 해줘",
  "이거 수정해줘", "저거 어디 있지", "그거 어떻게 됐어", "위에꺼 다시 한번",
  "그거 그대로 해줘", "아까 한 거 다시", "그 코드 다시 보여줘", "저번에 한 거 기억나?",
  "그 부분 수정해줘",
  "Do that again", "What about the thing we discussed earlier", "Show me that again",
  "Can you fix that", "Change it like I said before", "Continue from where we left off",
  "That thing from earlier, do it again", "Remember what we were working on",
  "Go back to the previous one", "Make it like the other one", "The same thing but different",
  "Update the one from before",
  "그거 해줘", "이거 해줘", "저거 어때", "How about this one", "What about that",
  "Try the other approach", "Use the one I mentioned", "Fix the issue",
  "그냥 그거", "이건 어때", "Make it better", "Change it", "이거 수정해",
];

const Q_PATTERNS: RegExp[] = [
  /^(아까|그거|저거|이거|그|위에|아래|저번|이전|전에).*(다시|해줘|해|보여|설명|수정|변경|삭제|추가|해봐)/,
  /^(그거|저거|이거|그|이|저)(만|만큼|대로|처럼|같이)?\s*(해줘|해|놔|둬|봐|어때|어떻게)/,
  /^(그거|저거|이거)\s*$/,
  /(아까|저번에|전에|위에서|앞에서|이전에).*(그|그거|그것|그때|했던|말한)/,
  /^(이거|저거|그거)(\s*.*)?$/,
];

const DEICTIC_WORDS = new Set(["그거", "저거", "이거", "그것", "이것", "저것", "아까", "저번"]);

function matchesQPattern(text: string): boolean {
  const trimmed = text.trim();
  for (const pattern of Q_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  if (trimmed.length < 20) {
    for (const word of DEICTIC_WORDS) {
      if (trimmed.includes(word)) return true;
    }
  }
  return false;
}


// ========== Short Text Heuristic ==========

const CODE_PATTERN = /[{}();]|function |const |let |var |class |import |export |=>|\bdef \b|\bfn\b/;
const TECH_TERMS = /\b(implement|create|design|architect|debug|refactor|migrate|deploy|build|write|develop)\b/i;

function isLikelyLight(text: string): boolean {
  const trimmed = text.trim();
  // Very short text without code patterns is almost always LIGHT
  if (trimmed.length <= 20 && !CODE_PATTERN.test(trimmed) && !TECH_TERMS.test(trimmed)) {
    return true;
  }
  return false;
}

// ========== Embedding Model (Lazy Singleton) ==========

type FeatureExtractionPipeline = (text: string | string[], options: { pooling: string; normalize: boolean }) => Promise<Tensor>;

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    console.log("[clawmux] Loading embedding model...");
    extractorPromise = pipeline("feature-extraction", MODEL_ID).then((pipe) => {
      console.log("[clawmux] Embedding model loaded");
      return pipe as FeatureExtractionPipeline;
    });
  }
  return extractorPromise;
}

// ========== Centroids ==========

let centroidsPromise: Promise<Record<string, number[]>> | null = null;

async function computeMeanEmbedding(texts: string[]): Promise<number[]> {
  const extractor = await getExtractor();
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE).map((t) => E5_PREFIX + t);
    const output = await extractor(batch, { pooling: "mean", normalize: true });
    const list = output.tolist() as number[][];
    for (const emb of list) {
      allEmbeddings.push(emb);
    }
  }

  if (allEmbeddings.length === 0) return [];

  const dim = allEmbeddings[0].length;
  const mean = new Array<number>(dim).fill(0);
  for (const emb of allEmbeddings) {
    for (let j = 0; j < dim; j++) {
      mean[j] += emb[j] / allEmbeddings.length;
    }
  }

  const magnitude = Math.sqrt(mean.reduce((sum, v) => sum + v * v, 0));
  if (magnitude > 0) {
    for (let j = 0; j < dim; j++) mean[j] /= magnitude;
  }

  return mean;
}

function getCentroids(): Promise<Record<string, number[]>> {
  if (!centroidsPromise) {
    centroidsPromise = (async () => {
      console.log("[clawmux] Computing category centroids...");
      const [cL, cM, cH, cQ] = await Promise.all([
        computeMeanEmbedding(TRAINING_LIGHT),
        computeMeanEmbedding(TRAINING_MEDIUM),
        computeMeanEmbedding(TRAINING_HEAVY),
        computeMeanEmbedding(TRAINING_Q),
      ]);
      console.log(
        `[clawmux] Centroids ready: L=${TRAINING_LIGHT.length} M=${TRAINING_MEDIUM.length} ` +
        `H=${TRAINING_HEAVY.length} Q=${TRAINING_Q.length} samples`,
      );
      return { [CAT_L]: cL, [CAT_M]: cM, [CAT_H]: cH, [CAT_Q]: cQ };
    })();
  }
  return centroidsPromise;
}

// ========== Cosine Similarity ==========

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom > 0 ? dot / denom : 0;
}

// ========== Public API ==========

export interface LocalClassifierConfig {
  contextMessages?: number;
  confidenceThreshold?: number;
}

export async function classifyLocal(
  messages: ReadonlyArray<Message>,
  config?: LocalClassifierConfig,
): Promise<ClassificationResult> {
  const userText = extractLastUserText(messages);
  if (!userText) {
    return {
      tier: "MEDIUM",
      confidence: 0.0,
      reasoning: "No user message found",
      error: "No user message found in request",
    };
  }

  const centroids = await getCentroids();
  const extractor = await getExtractor();
  const output = await extractor([E5_PREFIX + userText], { pooling: "mean", normalize: true });
  const inputEmb = (output.tolist() as number[][])[0];

  let bestCat = CAT_M;
  let bestSim = -Infinity;
  for (const [cat, centroid] of Object.entries(centroids)) {
    const sim = cosineSimilarity(inputEmb, centroid);
    if (sim > bestSim) {
      bestSim = sim;
      bestCat = cat;
    }
  }

  // Apply short-text heuristic: simple short texts are LIGHT
  if (isLikelyLight(userText) && bestCat !== CAT_Q) {
    bestCat = CAT_L;
    bestSim = Math.max(bestSim, 0.7);
  }

  const heuristicQ = matchesQPattern(userText);
  if (bestCat === CAT_Q || heuristicQ) {
    const contextText = buildContextText(messages, userText, config?.contextMessages ?? 10);
    const ctxOutput = await extractor([E5_PREFIX + contextText], { pooling: "mean", normalize: true });
    const contextEmb = (ctxOutput.tolist() as number[][])[0];

    let reBestCat = CAT_M;
    let reBestSim = -Infinity;
    for (const [cat, centroid] of Object.entries(centroids)) {
      if (cat === CAT_Q) continue;
      const sim = cosineSimilarity(contextEmb, centroid);
      if (sim > reBestSim) {
        reBestSim = sim;
        reBestCat = cat;
      }
    }

    const tier = TIER_MAP[reBestCat] ?? "MEDIUM";
    return {
      tier,
      confidence: reBestSim,
      reasoning: `Re-classified with context (initial: Q, heuristic: ${heuristicQ})`,
    };
  }

  const tier = TIER_MAP[bestCat] ?? "MEDIUM";
  return { tier, confidence: bestSim };
}

export function resetClassifier(): void {
  // Centroids are deterministic from static training data — no-op.
  // Embedding model stays loaded for performance.
}

export function getClassifierDebugInfo(): {
  categories: string[];
  stats: Record<string, { docCount: number; dimension: number; ready: boolean }>;
} {
  return {
    categories: ["LIGHT", "MEDIUM", "HEAVY"],
    stats: {
      LIGHT: { docCount: TRAINING_LIGHT.length, dimension: 384, ready: centroidsPromise !== null },
      MEDIUM: { docCount: TRAINING_MEDIUM.length, dimension: 384, ready: centroidsPromise !== null },
      HEAVY: { docCount: TRAINING_HEAVY.length, dimension: 384, ready: centroidsPromise !== null },
    },
  };
}

// ========== Utilities ==========

function extractLastUserText(messages: ReadonlyArray<Message>): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;

    if (typeof msg.content === "string") {
      return msg.content;
    }
    if (Array.isArray(msg.content)) {
      const parts: string[] = [];
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          parts.push(block.text);
        }
      }
      if (parts.length > 0) return parts.join(" ");
    }
  }
  return undefined;
}

function buildContextText(
  allMessages: ReadonlyArray<Message>,
  currentText: string,
  contextCount: number,
): string {
  const relevantMessages = allMessages.filter(
    (m) => m.role === "user" || m.role === "assistant",
  );

  const lastN = relevantMessages.slice(-contextCount);
  const parts: string[] = [];

  for (const msg of lastN) {
    let text: string;
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text)
        .join(" ");
    } else {
      continue;
    }
    parts.push(`[${msg.role}]: ${text}`);
  }

  const lastPart = parts[parts.length - 1];
  if (!lastPart || !lastPart.includes(currentText)) {
    parts.push(`[user]: ${currentText}`);
  }

  return parts.join("\n");
}
