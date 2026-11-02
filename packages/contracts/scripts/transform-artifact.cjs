#!/usr/bin/env node
/**
 * Transform Aztec codegen output to injectable artifact format.
 *
 * The Aztec codegen produces TS files that hardcode the contract artifact via a JSON
 * import. This script rewrites the constructor / at() / deploy() / deployWithOpts()
 * methods to take a `ContractArtifact` parameter instead, so the same generated TS can
 * be reused at runtime against artifacts loaded from elsewhere (the injectable artifact
 * pattern).
 *
 * Targets the codegen template shipped with aztec-packages from the deploy-API
 * refactor onwards (DeployMethod.create + DeployInstantiationOptions + args-as-array).
 *
 * Usage: node transform-artifact.cjs <input-file> [output-file]
 * If output-file is not provided, the input file will be overwritten.
 */

const fs = require('fs');
const path = require('path');

function transformArtifact(content) {
  const classMatch = content.match(/export class (\w+)Contract extends ContractBase/);
  if (!classMatch) {
    throw new Error('Could not find contract class definition');
  }
  const contractName = classMatch[1];
  const fullContractName = `${contractName}Contract`;
  const artifactConst = `${contractName}ContractArtifact`;

  // 1. Strip the JSON import line.
  content = content.replace(
    /import \w+ContractArtifactJson from ['"][^'"]+['"] with \{ type: ['"]json['"] \};\n?/g,
    ''
  );

  // 2. Strip the `export const XContractArtifact = loadContractArtifact(...)` line.
  content = content.replace(
    /export const \w+ContractArtifact = loadContractArtifact\([^;]+\);\n*/g,
    ''
  );

  // 3. Rewrite constructor to take the artifact as a parameter.
  content = content.replace(
    new RegExp(
      `private constructor\\(\\s*address: AztecAddress,\\s*wallet: Wallet,?\\s*\\)\\s*\\{\\s*super\\(address,\\s*${artifactConst},\\s*wallet\\);\\s*\\}`,
      'g'
    ),
    `private constructor(address: AztecAddress, artifact: ContractArtifact, wallet: Wallet) {
    super(address, artifact, wallet);
  }`
  );

  // 4. Rewrite at() to take the artifact as a parameter.
  content = content.replace(
    new RegExp(
      `public static at\\(\\s*address: AztecAddress,\\s*wallet: Wallet,?\\s*\\):\\s*${fullContractName}\\s*\\{\\s*return Contract\\.at\\(address,\\s*${fullContractName}\\.artifact,\\s*wallet\\)\\s*as\\s*${fullContractName};\\s*\\}`,
      'g'
    ),
    `public static at(address: AztecAddress, artifact: ContractArtifact, wallet: Wallet): ${fullContractName} {
    return Contract.at(address, artifact, wallet) as ${fullContractName};
  }`
  );

  // 5. Rewrite deploy() to thread the artifact through.
  //    Matches the new-template body:
  //      public static deploy(wallet: Wallet, <args...>, instantiation?: DeployInstantiationOptions) {
  //        return DeployMethod.create<X>(wallet, { artifact: XContractArtifact, postDeployCtor, args: [...] }, instantiation);
  //      }
  const deployBodyRegex = new RegExp(
    [
      // signature
      `public static deploy\\(wallet: Wallet,([\\s\\S]*?)instantiation\\?: DeployInstantiationOptions\\)`,
      // body up to artifact:
      `\\s*\\{\\s*return DeployMethod\\.create<${fullContractName}>\\(\\s*wallet,\\s*\\{\\s*`,
      `artifact:\\s*${artifactConst},\\s*`,
      `postDeployCtor:\\s*\\(instance,\\s*wallet\\)\\s*=>\\s*${fullContractName}\\.at\\(instance\\.address,\\s*wallet\\),\\s*`,
      `args:\\s*(\\[[\\s\\S]*?\\]),?\\s*`,
      `\\},\\s*instantiation,?\\s*\\);?\\s*\\}`,
    ].join(''),
    'g'
  );
  content = content.replace(deployBodyRegex, (_match, ctorArgs, argsArray) => {
    const trimmed = ctorArgs.trim().replace(/,$/, '');
    const argsSection = trimmed ? ` ${trimmed},` : '';
    return `public static deploy(wallet: Wallet, artifact: ContractArtifact,${argsSection} instantiation?: DeployInstantiationOptions) {
    return DeployMethod.create<${fullContractName}>(
      wallet,
      {
        artifact,
        postDeployCtor: (instance, wallet) => ${fullContractName}.at(instance.address, artifact, wallet),
        args: ${argsArray},
      },
      instantiation,
    );
  }`;
  });

  // 6. Rewrite deployWithOpts() to take opts.artifact.
  const deployWithOptsRegex = new RegExp(
    [
      `public static deployWithOpts<M extends keyof ${fullContractName}\\['methods'\\]>\\(\\s*`,
      `opts:\\s*\\{\\s*method\\?:\\s*M;\\s*wallet:\\s*Wallet;\\s*instantiation\\?:\\s*DeployInstantiationOptions\\s*\\},\\s*`,
      `\\.\\.\\.args:\\s*Parameters<${fullContractName}\\['methods'\\]\\[M\\]>\\s*\\)\\s*\\{\\s*`,
      `return DeployMethod\\.create<${fullContractName}>\\(\\s*opts\\.wallet,\\s*\\{\\s*`,
      `artifact:\\s*${artifactConst},\\s*`,
      `postDeployCtor:\\s*\\(instance,\\s*wallet\\)\\s*=>\\s*${fullContractName}\\.at\\(instance\\.address,\\s*wallet\\),\\s*`,
      `args,\\s*`,
      `constructorNameOrArtifact:\\s*opts\\.method\\s*\\?\\?\\s*['"]constructor['"],?\\s*`,
      `\\},\\s*opts\\.instantiation,?\\s*\\);?\\s*\\}`,
    ].join(''),
    'g'
  );
  content = content.replace(
    deployWithOptsRegex,
    `public static deployWithOpts<M extends keyof ${fullContractName}["methods"]>(
    opts: { method?: M; wallet: Wallet; instantiation?: DeployInstantiationOptions; artifact: ContractArtifact },
    ...args: Parameters<${fullContractName}["methods"][M]>
  ) {
    return DeployMethod.create<${fullContractName}>(
      opts.wallet,
      {
        artifact: opts.artifact,
        postDeployCtor: (instance, wallet) => ${fullContractName}.at(instance.address, opts.artifact, wallet),
        args,
        constructorNameOrArtifact: opts.method ?? "constructor",
      },
      opts.instantiation,
    );
  }`
  );

  // 7. Drop the static `artifact` getter — the imported constant it returned is gone.
  content = content.replace(
    /\s*\/\*\*\s*\n\s*\* Returns this contract's artifact\.\s*\n\s*\*\/\s*\n\s*public static get artifact\(\)[\s\S]*?\n\s{2}\}/g,
    ''
  );

  // 8. Drop the static `artifactForPublic` getter — same reason.
  content = content.replace(
    /\s*\/\*\*\s*\n\s*\* Returns this contract's artifact with public bytecode\.\s*\n\s*\*\/\s*\n\s*public static get artifactForPublic\(\)[\s\S]*?\n\s{2}\}/g,
    ''
  );

  // 9. Normalize single-quoted literals that the codegen sprinkles in.
  content = content.replace(/'methods'/g, '"methods"');
  content = content.replace(/'selector'/g, '"selector"');

  // 10. Collapse extra blank lines from removals.
  content = content.replace(/\n{3,}/g, '\n\n');

  return content;
}

function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error('Usage: node transform-artifact.cjs <input-file> [output-file]');
    process.exit(1);
  }

  const inputFile = args[0];
  const outputFile = args[1] || inputFile;

  if (!fs.existsSync(inputFile)) {
    console.error(`Error: Input file not found: ${inputFile}`);
    process.exit(1);
  }

  try {
    const content = fs.readFileSync(inputFile, 'utf8');

    // A file is considered untransformed if it still has the JSON import.
    const needsTransform = content.includes('ContractArtifactJson from');

    if (!needsTransform) {
      console.log(`Skipping ${path.basename(inputFile)} - already transformed`);
      process.exit(0);
    }

    const transformed = transformArtifact(content);

    // Sanity check: a complete transform leaves no references to the artifact constant.
    const className = (content.match(/export class (\w+)Contract extends ContractBase/) || [])[1];
    if (className && transformed.includes(`${className}ContractArtifact`)) {
      console.error(
        `Error transforming ${path.basename(inputFile)}: residual reference to ${className}ContractArtifact remains. ` +
          `Codegen template likely changed; transform-artifact.cjs needs updating.`
      );
      process.exit(1);
    }

    fs.writeFileSync(outputFile, transformed, 'utf8');
    console.log(`Transformed: ${path.basename(inputFile)}`);
  } catch (error) {
    console.error(`Error transforming ${inputFile}: ${error.message}`);
    process.exit(1);
  }
}

main();
