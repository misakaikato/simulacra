import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: ["node_modules/", "dist/", "gui/dist/", "simulacra-data/"],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		rules: {
			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/no-non-null-assertion": "error",
			"@typescript-eslint/consistent-type-imports": [
				"error",
				{ prefer: "type-imports", fixStyle: "inline-type-imports" },
			],
			"@typescript-eslint/consistent-type-assertions": [
				"error",
				{ assertionStyle: "as", objectLiteralTypeAssertions: "never" },
			],
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
			"no-restricted-properties": [
				"error",
				{
					object: "Math",
					property: "random",
					message: "Use Rng derived from the scenario seed.",
				},
			],
		},
	},
	{
		files: ["tests/**/*.ts"],
		rules: {
			"@typescript-eslint/no-non-null-assertion": "off",
		},
	},
);
