/**
 * Visual grouping for the 12-character rendezvous code. Three groups
 * of four read aloud cleanly ("ABCD dash EFGH dash JKMN") and match
 * the dashed shape `normalizeCode` already tolerates as input.
 */

const GROUP_SIZE = 4;

export function formatCodeForDisplay(code: string): string {
	const out: string[] = [];
	for (let i = 0; i < code.length; i += GROUP_SIZE) {
		out.push(code.slice(i, i + GROUP_SIZE));
	}
	return out.join("-");
}
