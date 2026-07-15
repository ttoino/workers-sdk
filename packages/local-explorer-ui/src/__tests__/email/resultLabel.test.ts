import { describe, test } from "vitest";
import {
	RESULT_BADGE_VARIANT,
	RESULT_LABEL,
	resolveResult,
	type ResultKind,
} from "../../components/email/resultLabel";

describe("resolveResult", () => {
	test("maps a worker hand-off (dropped + worker) to handled", ({ expect }) => {
		expect(resolveResult({ status: "dropped", action: "worker" })).toBe(
			"handled"
		);
	});

	test("does not treat a worker error as handled", ({ expect }) => {
		// Only `dropped` + worker is a hand-off; other statuses keep their meaning.
		expect(resolveResult({ status: "error", action: "worker" })).toBe("error");
	});

	test("maps delivered + forward to forwarded", ({ expect }) => {
		expect(resolveResult({ status: "delivered", action: "forward" })).toBe(
			"forwarded"
		);
	});

	test("maps a delivered worker reply/send (action unknown) to delivered", ({
		expect,
	}) => {
		expect(resolveResult({ status: "delivered", action: "unknown" })).toBe(
			"delivered"
		);
	});

	test("maps delivered with no action to delivered", ({ expect }) => {
		expect(resolveResult({ status: "delivered" })).toBe("delivered");
	});

	test("maps each status to its kind", ({ expect }) => {
		const cases: Array<[string, ResultKind]> = [
			["deliveryFailed", "deliveryFailed"],
			["dropped", "dropped"],
			["error", "error"],
		];
		for (const [status, kind] of cases) {
			expect(resolveResult({ status })).toBe(kind);
		}
	});

	test("falls back to unknown for an unrecognized or empty status", ({
		expect,
	}) => {
		expect(resolveResult({ status: "somethingNew" })).toBe("unknown");
		expect(resolveResult({ status: "" })).toBe("unknown");
	});
});

describe("result maps", () => {
	const KINDS: ResultKind[] = [
		"delivered",
		"forwarded",
		"handled",
		"dropped",
		"deliveryFailed",
		"error",
		"unknown",
	];

	test("has a label and a badge variant for every kind", ({ expect }) => {
		for (const kind of KINDS) {
			expect(RESULT_LABEL[kind]).toBeTruthy();
			expect(RESULT_BADGE_VARIANT[kind]).toBeTruthy();
		}
	});

	test("labels the worker hand-off as 'Handled'", ({ expect }) => {
		expect(RESULT_LABEL.handled).toBe("Handled");
	});

	test("renders delivered/forwarded as success and dropped as a neutral outline", ({
		expect,
	}) => {
		expect(RESULT_BADGE_VARIANT.delivered).toBe("success");
		expect(RESULT_BADGE_VARIANT.forwarded).toBe("success");
		expect(RESULT_BADGE_VARIANT.dropped).toBe("outline");
		expect(RESULT_BADGE_VARIANT.deliveryFailed).toBe("error");
		expect(RESULT_BADGE_VARIANT.error).toBe("error");
	});
});
