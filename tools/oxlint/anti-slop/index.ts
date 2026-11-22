import { eslintCompatPlugin } from "@oxlint/plugins";

import { noChainedTypeAssertionsRule } from "./rules/no-chained-type-assertions.ts";
import { noReflectApplyRule } from "./rules/no-reflect-apply.ts";
import { noReflectGetRule } from "./rules/no-reflect-get.ts";
import { noUnknownTypeAliasesRule } from "./rules/no-unknown-type-aliases.ts";
import { noUnsafeDictionaryTypeRule } from "./rules/no-unsafe-dictionary-type.ts";

/**
 * Subset of https://github.com/dmmulroy/anti-slop judged compatible with this repo's
 * conventions. Excludes no-module-mocking (conflicts with the vi.mock-based .remote.ts
 * test seam), no-shape-in-symbol-names (false-positives on this repo's real chart/canvas
 * "shape" domain terms), require-safety-comment-for-type-assertion (too broad at current
 * volume — ~3.2k sites), no-widen-then-assert/no-known-value-widening/no-object-parameters/
 * no-unknown-parameters/no-unknown-returns/no-runtime-typeof/no-conditional-empty-object-spread
 * (not yet measured), and the Effect-specific rule (this repo doesn't use Effect).
 *
 * no-unsafe-dictionary-type and no-chained-type-assertions were both deferred pending a
 * cleanup pass (issue #702); both are enforced now, each with scoped .oxlintrc.json
 * overrides for test/vendored files that have no schema contract to enforce.
 */
const antiSlopPlugin = eslintCompatPlugin({
	meta: { name: "anti-slop" },
	rules: {
		"no-chained-type-assertions": noChainedTypeAssertionsRule,
		"no-reflect-apply": noReflectApplyRule,
		"no-reflect-get": noReflectGetRule,
		"no-unknown-type-aliases": noUnknownTypeAliasesRule,
		"no-unsafe-dictionary-type": noUnsafeDictionaryTypeRule,
	},
});

export default antiSlopPlugin;
