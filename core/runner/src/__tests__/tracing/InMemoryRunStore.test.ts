import { InMemoryRunStore } from "../../tracing/InMemoryRunStore";
import { runStoreTests } from "./RunStore.shared";

runStoreTests("InMemoryRunStore", () => new InMemoryRunStore());
