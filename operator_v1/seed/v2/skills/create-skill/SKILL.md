# Create a skill

Seed version: 2

1. Search for the capability before authoring. Reuse a suitable active skill.
2. Define the inputs and an observable success condition. Use skill_dependencies to inspect the commands the owner permits. Declare the dependencies your skill actually uses.
3. Write run.lua yourself. It returns a function that receives the input object and returns JSON-compatible data. Use run(dependency, arg1, ...) to obtain approved command stdout, and json_decode(text) to parse a JSON object or array. The language environment provides arithmetic, string and table operations. An empty result table encodes as an empty array.
4. Submit the manifest, entrypoint text, and self-tests together through skill_scaffold. The tests supply expected command calls and mock stdout in order. Use one test per observable branch.
5. Run skill_test at the returned full Git revision. Activate the tested revision with skill_activate. If named discovery is cached, call skill_invoke with an arguments object.
6. Use the skill on the owner's actual input and report what the tool returned. Keep authored tests separate from independent verification.
