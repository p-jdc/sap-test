# Skills for Claude Code

Instructions Claude Code loads when a task matches a skill's description. They cost nothing until
then.

| Skill                            | From                                          | Use                                                                                                   |
| -------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `svelte-code-writer`             | sveltejs (MIT), via the reference app         | Process for every `.svelte` edit: documentation lookups and checks go through the `svelte-docs` agent |
| `svelte-core-bestpractices`      | sveltejs (MIT), via the reference app         | What good Svelte 5 looks like; async Svelte and its one known trap                                    |
| `svelte-testing`                 | spences10/sveltest (MIT)                      | Component and server tests with vitest-browser-svelte                                                 |
| `verification-before-completion` | obra/superpowers (MIT, licence in the folder) | No "done" without having run the command that proves it; lists this repo's commands                   |
| `verify`                         | written here                                  | Starting the app on its own port and data directory and driving it in a browser                       |

The copied skills were adapted: paths, commands and versions are this repo's, and parts about the
reference app's own code were removed. When updating one from its source, keep the "in this repo"
sections.
