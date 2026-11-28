import { findPackageJSON } from 'node:module';
import { bundleLanguage } from '@repometry/cli/internal/distribution';
import type { Distribution } from '@repometry/cli/internal/distribution';
import goManifest, { go } from '@repometry/language-go';
import pythonManifest, { python } from '@repometry/language-python';
import javaManifest, { java } from '@repometry/language-java';
import phpManifest, { php } from '@repometry/language-php';
import rubyManifest, { ruby } from '@repometry/language-ruby';
import kotlinManifest, { kotlin } from '@repometry/language-kotlin';
import hclManifest, { hcl } from '@repometry/language-hcl';
import luaManifest, { lua } from '@repometry/language-lua';
import scalaManifest, { scala } from '@repometry/language-scala';
import elixirManifest, { elixir } from '@repometry/language-elixir';
import rustManifest, { rust } from '@repometry/language-rust';

const distribution: Distribution = {
  bundled: [
    bundleLanguage(goManifest, go.language),
    bundleLanguage(pythonManifest, python.language),
    bundleLanguage(javaManifest, java.language, true),
    bundleLanguage(phpManifest, php.language, true),
    bundleLanguage(rubyManifest, ruby.language, true),
    bundleLanguage(kotlinManifest, kotlin.language, true),
    bundleLanguage(hclManifest, hcl.language, true),
    bundleLanguage(luaManifest, lua.language, true),
    bundleLanguage(scalaManifest, scala.language, true),
    bundleLanguage(elixirManifest, elixir.language, true),
    bundleLanguage(rustManifest, rust.language, true),
  ],
  moduleUrl: import.meta.url,
  packageUrl: new URL('../../../package.json', import.meta.url).href,
  resolvePackage: name => ({ url: import.meta.resolve(name), manifest: findPackageJSON(name, import.meta.url) }),
};

export default distribution;
