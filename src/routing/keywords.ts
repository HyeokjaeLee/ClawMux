import type { ScoringWeights } from "./types.ts";

export const CODE_KEYWORDS = [
  "function", "class", "import", "def", "select", "async", "await",
  "const", "let", "var", "return", "```", "api", "endpoint", "sdk",
  "component", "module", "interface", "type ", "struct", "regex",
  "query", "mutation", "graphql", "rest api", "webhook", "middleware",
  "orm", "migration", "schema", "index", "join", "aggregate",
  "callback", "promise", "observable", "decorator", "annotation",
  "generic", "polymorphism", "inheritance", "refactor", "lint",
  "transpile", "bundle", "minify", "unit test", "integration test",
  "mock", "stub", "fixture", "git merge", "git rebase",
  "pull request", "code review",
] as const;

export const REASONING_KEYWORDS = [
  "prove", "theorem", "derive", "step by step", "chain of thought",
  "formally", "mathematical", "proof", "logically", "analyze why",
  "root cause", "trade-off", "compare and contrast", "evaluate",
  "synthesize", "critically assess", "weigh the pros and cons",
  "what are the implications", "long-term impact", "second-order effects",
  "argue for and against", "devil's advocate", "counterargument",
  "why does this matter", "what would happen if", "thought experiment",
  "from first principles", "break down the reasoning", "causal analysis",
  "correlation vs causation", "what's the underlying assumption",
  "strategic analysis", "scenario planning", "risk assessment",
  "cost-benefit analysis", "decision matrix", "framework for thinking",
  "systems thinking", "feedback loop", "unintended consequences",
  "analyze", "compare", "methodology", "pros and cons", "implications",
] as const;

export const TECHNICAL_KEYWORDS = [
  "algorithm", "optimize", "architecture", "distributed", "kubernetes",
  "microservice", "database", "infrastructure", "deploy", "pipeline",
  "ci/cd", "terraform", "docker", "nginx", "security", "firewall",
  "harden", "vulnerability", "config", "load balancer", "auto-scaling",
  "failover", "redundancy", "replication", "sharding", "caching",
  "redis", "elasticsearch", "kafka", "rabbitmq", "grpc", "protobuf",
  "service mesh", "istio", "envoy", "ssl", "tls", "certificate",
  "dns", "cdn", "cloudfront", "s3", "lambda", "serverless", "ecs",
  "fargate", "ec2", "gke", "aks", "prometheus", "grafana", "datadog",
  "splunk", "observability", "latency", "throughput", "p99", "sla",
  "slo", "sli", "incident response", "postmortem", "runbook",
  "playbook", "backup", "disaster recovery", "rpo", "rto",
  "high availability", "rate limiting", "circuit breaker", "retry",
  "exponential backoff", "blue-green", "canary deployment",
  "feature flag", "rollback", "data lake", "data warehouse", "etl",
  "dbt", "airflow", "spark", "machine learning", "model training",
  "inference", "embedding", "vector database", "rag", "fine-tuning",
  "prompt engineering", "optimization", "api",
] as const;

export const CREATIVE_KEYWORDS = [
  "story", "poem", "compose", "brainstorm", "creative", "imagine",
  "write a", "draft", "narrative", "blog post", "article", "essay",
  "newsletter", "press release", "pitch deck", "presentation",
  "speech", "talking points", "tagline", "slogan", "headline",
  "copy", "ad copy", "social media post", "tweet", "caption", "hook",
  "tone of voice", "brand voice", "messaging guide", "outline",
  "storyboard", "script", "dialogue", "fiction",
] as const;

export const SIMPLE_KEYWORDS = [
  "what is", "define", "translate", "hello", "yes or no", "capital of",
  "how old", "who is", "when was", "what time", "remind me",
  "heartbeat", "status check", "acknowledge", "react", "thumbs up",
  "thank you", "thanks", "ok", "got it", "sounds good", "sure",
  "what does", "meaning of", "synonym", "antonym", "spell",
  "how do you say", "convert", "how many", "how much", "how far",
  "what day", "what year", "timezone", "weather", "temperature",
  "open hours", "phone number", "address of", "directions to", "eta",
  "tracking number", "order status", "password reset", "where is my",
  "when does", "is it open", "business hours", "holiday schedule",
  "office location", "contact info", "hi", "how do i", "yes", "no",
] as const;

export const MULTI_STEP_REGEX_PATTERNS = [
  "first.*then", "step \\d", "\\d\\.\\s", "next,?\\s",
  "phase \\d", "stage \\d", "\\d\\)", "[a-z]\\)",
] as const;

export const MULTI_STEP_LITERAL_PATTERNS = [
  "after that", "once done", "and also", "followed by", "subsequently",
  "in sequence", "milestone", "workflow", "pipeline",
  "before we", "after we", "while we", "in parallel",
] as const;

export const AGENTIC_KEYWORDS = [
  "read file", "edit", "modify", "update the", "create file",
  "execute", "deploy", "install", "compile", "fix", "debug",
  "until it works", "keep trying", "iterate", "make sure", "verify",
  "triage all", "triage every", "broadcast", "assign to",
  "prioritize the", "prioritize all", "rank all", "summarize all",
  "review all", "audit", "investigate", "schedule", "automate",
  "set up a cron", "monitor", "scrape", "crawl", "extract from",
  "parse", "transform", "migrate", "sync", "backup", "restore",
  "archive", "onboard", "provision", "decommission",
  "rotate credentials", "generate report", "pull metrics", "dashboard",
  "file a ticket", "create issue", "open a bug", "submit pr", "merge",
  "release", "tag version", "changelog", "run tests", "check coverage",
  "benchmark", "profile", "scan for", "detect", "classify",
  "categorize", "label", "enrich", "deduplicate", "reconcile",
  "validate against", "cross-reference", "look up", "fetch from",
  "query the", "scan", "check every", "triage",
] as const;

export const IMPERATIVE_KEYWORDS = [
  "build", "create", "implement", "design", "develop", "generate",
  "configure", "set up", "construct", "write", "rewrite", "refactor",
  "restructure", "reorganize", "plan", "outline", "map out", "diagram",
  "document", "research", "explore", "prototype", "experiment", "test",
  "launch", "ship", "deliver", "finalize", "publish", "clean up",
  "simplify", "consolidate", "standardize", "propose", "recommend",
  "suggest", "advise", "update", "deploy",
] as const;

export const CONSTRAINT_KEYWORDS = [
  "at most", "at least", "within", "no more than", "maximum",
  "minimum", "limit", "budget", "under ", "deadline", "by end of",
  "before", "no later than", "scope", "out of scope", "must have",
  "nice to have", "blocker", "dependency", "prerequisite",
  "requirement", "compliance", "regulation", "policy", "sla", "kpi",
  "target", "threshold", "benchmark", "baseline", "capacity",
  "headcount", "resource constraint", "must", "should not", "only if",
  "ensure", "require",
] as const;

export const FORMAT_KEYWORDS = [
  "json", "yaml", "xml", "table", "csv", "markdown", "schema",
  "format as", "structured", "spreadsheet", "pdf", "docx",
  "slide deck", "powerpoint", "gantt chart", "org chart", "flowchart",
  "diagram", "template", "form", "checklist", "rubric", "scorecard",
  "report format", "executive summary", "one-pager", "brief",
] as const;

export const DOMAIN_KEYWORDS = [
  "quantum", "fpga", "vlsi", "risc-v", "genomics", "proteomics",
  "homomorphic", "zero-knowledge", "lattice-based", "topological",
  "regression", "p-value", "gradient descent", "polymorphism",
  "microservice", "kubernetes", "lms", "learning management", "scorm",
  "xapi", "tin can", "course catalog", "enrollment", "gradebook",
  "rubric", "learning outcome", "competency", "credential",
  "certificate", "transcript", "academic record", "degree audit",
  "curriculum", "syllabus", "lesson plan", "assessment", "quiz",
  "exam", "proctoring", "plagiarism", "student engagement",
  "retention", "completion rate", "dropout", "adaptive learning",
  "personalized learning", "learning path", "tutoring", "mentoring",
  "accreditation", "ferpa", "hipaa",
] as const;

export const RELAY_KEYWORDS = [
  "send to", "post to", "forward to", "relay to", "ops alert",
  "healthcheck", "transcribe", "voice note", "check email",
  "check inbox", "new mail", "unread", "git pull", "git push",
  "git status", "git log", "ping ", "notify ", "tell ",
  "send message", "send slack", "send teams", "send whatsapp",
  "post in channel", "dm ", "reply to", "react with",
  "mark as read", "archive email", "label email", "flag email",
  "set reminder", "snooze", "mute", "unmute", "check calendar",
  "next meeting", "rsvp", "accept invite", "check notifications",
  "clear alerts", "ack", "acknowledge", "forward", "pass along",
  "relay",
] as const;

export const DEFAULT_WEIGHTS: ScoringWeights = {
  tokenCount: 0.08,
  codePresence: 0.14,
  reasoningMarkers: 0.18,
  technicalTerms: 0.10,
  creativeMarkers: 0.04,
  simpleIndicators: 0.06,
  multiStepPatterns: 0.06,
  questionComplexity: 0.05,
  imperativeVerbs: 0.04,
  constraints: 0.05,
  outputFormat: 0.04,
  domainSpecificity: 0.06,
  agenticTasks: 0.06,
  relayIndicators: 0.04,
} as const satisfies ScoringWeights;

export const DEFAULT_BOUNDARIES = {
  lightMedium: 0.0,
  mediumHeavy: 0.35,
} as const;

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;
