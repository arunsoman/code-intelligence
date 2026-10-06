import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { setup } from "./helpers.ts";
import { guards } from "../src/forms/analysis.ts";
import { flowGraph } from "../src/forms/common.ts";

const SPRING_REPO = resolve(import.meta.dirname, "../../../fixtures/spring-repo");

test("Spring fixture: framework metadata becomes facts and relationships", async () => {
  const { svc, worker, revision } = await setup(undefined, SPRING_REPO);
  try {
    const facts = svc.store.allFacts(revision);
    const rels = svc.store.allRelationships(revision);

    // Framework roles annotate existing class entities.
    assert.ok(facts.some((f) => f.predicate === "framework_role" && (f.object as any).value.role === "controller" && f.subject.includes("PaymentController")));
    assert.ok(facts.some((f) => f.predicate === "framework_role" && (f.object as any).value.role === "provider" && f.subject.includes("PaymentService")));
    assert.ok(facts.some((f) => f.predicate === "framework_role" && (f.object as any).value.role === "provider" && f.subject.includes("UserRepository")));

    // Spring Security guard from @PreAuthorize.
    assert.ok(facts.some((f) => f.predicate === "framework_role" && (f.object as any).value.role === "guard" && f.subject.includes("PaymentController.create")));

    // Route fact.
    assert.ok(facts.some((f) => f.predicate === "route" && (f.object as any).value.path === "/payments/{userId}" && (f.object as any).value.method === "POST"));

    // Constructor injection resolved to concrete classes.
    assert.ok(rels.some((r) => r.kind === "injects" && r.from.includes("PaymentService.PaymentService") && r.to.includes("UserRepository")));
    assert.ok(rels.some((r) => r.kind === "injects" && r.from.includes("PaymentController.PaymentController") && r.to.includes("PaymentService")));

    // Controller exposes route.
    assert.ok(rels.some((r) => r.kind === "exposes_route" && r.from.includes("PaymentController") && r.label === "POST /payments/{userId}"));

    // Transactional method, enriched by the framework indexer.
    assert.ok(facts.some((f) => f.predicate === "uses_transaction" && f.subject.includes("PaymentService.charge") && (f.object as any).framework === "spring"));
  } finally {
    worker.close();
  }
});

test("Spring fixture: guards() recognises @PreAuthorize as a gate", async () => {
  const { svc, worker, revision } = await setup(undefined, SPRING_REPO);
  try {
    const flow = flowGraph(svc.store, revision);
    const g = guards(svc.store, revision, flow);
    const guardIds = [...g.keys()];
    assert.ok(guardIds.some((id) => id.includes("PaymentController.create")), `guards: ${guardIds.join(", ")}`);
    const fwGuard = guardIds.find((id) => id.includes("PaymentController.create"))!;
    assert.equal(g.get(fwGuard)!.frameworkGuard, true);
  } finally {
    worker.close();
  }
});

test("Spring fixture: journey marks transactional charge step", async () => {
  const { svc, worker, revision } = await setup(undefined, SPRING_REPO);
  try {
    const rev = svc.store.revision(revision)!;
    const { buildJourney } = await import("../src/forms/journey.ts");
    const { view } = buildJourney(svc.store, rev, "walk me through create payment", "PaymentController.create");
    const chargeNode = view.nodes.find((n) => n.entityRefs.some((id) => id.includes("PaymentService.charge")));
    assert.ok(chargeNode, "charge step should be in the journey");
    assert.ok(chargeNode!.notes!.some((note) => /Spring transaction/.test(note)), `notes: ${chargeNode!.notes!.join("; ")}`);
    assert.ok(chargeNode!.badge?.includes("transactional"), `badge: ${chargeNode!.badge}`);
  } finally {
    worker.close();
  }
});

test("Spring fixture: Spring Cloud Gateway routes and filters are extracted", async () => {
  const { svc, worker, revision } = await setup(undefined, SPRING_REPO);
  try {
    const facts = svc.store.allFacts(revision);
    const rels = svc.store.allRelationships(revision);
    const entities = svc.store.entities(revision);

    // Java DSL routes.
    assert.ok(entities.some((e) => e.kind === "spring_cloud_gateway_route" && e.name === "payments"));
    assert.ok(entities.some((e) => e.kind === "spring_cloud_gateway_route" && e.name === "orders"));

    // Route facts.
    assert.ok(facts.some((f) => f.predicate === "gateway_route" && (f.object as any).value.id === "payments"));
    assert.ok(facts.some((f) => f.predicate === "gateway_route" && (f.object as any).value.id === "orders"));

    // DSL filters are entities; route-to-filter relationships exist.
    assert.ok(entities.some((e) => e.kind === "spring_cloud_gateway_filter" && e.name.includes("circuitBreaker")));
    assert.ok(rels.some((r) => r.kind === "uses_filter" && r.from.includes("payments") && r.to.includes("circuitBreaker")));

    // YAML route from application.yml.
    assert.ok(entities.some((e) => e.kind === "spring_cloud_gateway_route" && e.name === "payments-route"));

    // Custom GatewayFilter class is a framework role.
    assert.ok(facts.some((f) => f.predicate === "framework_role" && (f.object as any).value.role === "gateway_filter" && f.subject.includes("AuthFilter")));
  } finally {
    worker.close();
  }
});

test("Spring fixture: pom.xml and application properties are extracted", async () => {
  const { svc, worker, revision } = await setup(undefined, SPRING_REPO);
  try {
    const facts = svc.store.allFacts(revision);

    assert.ok(facts.some((f) => f.predicate === "config_value" && (f.object as any).value.key === "pom.xml:artifactId" && (f.object as any).value.value === "payments"));
    assert.ok(facts.some((f) => f.predicate === "config_value" && (f.object as any).value.key === "pom.xml:java.version" && (f.object as any).value.value === "17"));
    assert.ok(facts.some((f) => f.predicate === "active_profile" && (f.object as any).value.profile === "dev"));
    assert.ok(facts.some((f) => f.predicate === "config_value" && (f.object as any).value.key === "spring:payments.api.key"));
  } finally {
    worker.close();
  }
});
