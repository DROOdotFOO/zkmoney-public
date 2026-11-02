# Compiles Noir packages with the pinned Aztec toolchain, one derivation per package: contracts with its own
# `aztec compile`, circuits with its nargo. docs/conventions/noir-nix-build.md lists what each one's key covers.
{
  # JSON list of { dir, args?, vk? }: a repo-relative package directory, its compile arguments and,
  # for a circuit whose verification key is pinned, vk = true, as
  # packages/contracts/scripts/build_contracts.sh decides them.
  spec ? "[]",
}:
let
  inherit (import ./common.nix)
    pkgs
    lib
    repo
    lock
    aztecToolchain
    aztecNpmDeps
    manifest
    safeKey
    gitKey
    closure
    fetchGitDep
    ;

  # A fetch's store path is its name and hash, so each fetch is named after its version: a bump that misses a hash
  # fails instead of reusing the previous release's download.
  aztecVersion = "6.0.0";
  noirVersion = "1.0.0-rc.3";
  nodejs = pkgs.nodejs_24;

  # The toolchain release's own pins, and the repo's: a bump that misses one fails evaluation instead of compiling
  # with a stale compiler.
  aztecPins = builtins.readFile (
    pkgs.fetchurl {
      name = "aztec-${aztecVersion}-versions";
      url = "https://install.aztec-labs.com/${aztecVersion}/versions";
      hash = "sha256-IZk9x3H9hUOcp28u+YCBJXN9miEwaa8LpoIlwUnnji8=";
    }
  );
  toolchainLock = lib.importJSON ./aztec-toolchain/package-lock.json;
  updateVersions = (lib.importJSON (repo + "/package.json")).scripts.update-versions;
  bump = "; see Updating in docs/conventions/noir-nix-build.md, or build without ENABLE_NIX";
  pinsAgree =
    assert lib.assertMsg (lib.hasInfix "noir: ${noirVersion}\n" aztecPins)
      "nix/default.nix pins nargo ${noirVersion}, Aztec ${aztecVersion} does not${bump}";
    assert lib.assertMsg (toolchainLock.packages."node_modules/@aztec-labs/aztec".version == aztecVersion)
      "nix/aztec-toolchain/package-lock.json does not resolve @aztec-labs/aztec ${aztecVersion}${bump}";
    assert lib.assertMsg (builtins.match ".*--newVersion v${lib.escapeRegex aztecVersion}( .*)?" updateVersions != null)
      "nix/default.nix pins Aztec ${aztecVersion}, the root package.json does not${bump}";
    true;

  # The release aztec-up installs as internal-bin/nargo.
  nargo = pkgs.stdenv.mkDerivation {
    pname = "nargo";
    version = noirVersion;
    src = pkgs.fetchurl {
      name = "noir-${noirVersion}-x86_64-unknown-linux-gnu.tar.gz";
      url = "https://github.com/noir-lang/noir/releases/download/v${noirVersion}/noir-x86_64-unknown-linux-gnu.tar.gz";
      hash = "sha256-V5Ldlir84e7YNFcPldn3LMSgnUXNhG07gLelc5JzKXM=";
    };
    sourceRoot = ".";
    nativeBuildInputs = [ pkgs.autoPatchelfHook ];
    buildInputs = [ pkgs.stdenv.cc.cc.lib ];
    installPhase = "install -Dm755 nargo $out/bin/nargo";
  };

  # The npm packages aztec-up installs, from the release's own lock (aztec-toolchain/, copied from its packages.tar.gz).
  aztec = pkgs.buildNpmPackage {
    pname = "aztec-toolchain";
    version = aztecVersion;
    src = aztecToolchain;
    inherit nodejs;
    npmDeps = aztecNpmDeps lock.aztecToolchainNpmDeps;
    npmFlags = [ "--ignore-scripts" ];
    dontNpmBuild = true;
    nativeBuildInputs = [ pkgs.autoPatchelfHook ];
    installPhase = ''
      mkdir -p $out
      mv node_modules $out/
      autoPatchelf $out/node_modules/@aztec-foundation/bb.js/build/amd64-linux/bb
    '';
    dontFixup = true;
  };

  # bb's CRS, for the packages that run bb. It never changes.
  crs =
    lib.mapAttrsToList
      (name: pin: {
        inherit name;
        file = pkgs.fetchurl {
          inherit name;
          url = "https://crs.aztec-cdn.foundation/${pin.remote}";
          # A header, not --range: fetchurl's own --continue-at excludes that flag.
          curlOptsList = [
            "--header"
            "Range: bytes=0-${toString (pin.bytes - 1)}"
          ];
          inherit (pin) sha256;
        };
      })
      {
        "bn254_g1_compressed.dat" = {
          remote = "g1_compressed.dat";
          bytes = 16777216;
          sha256 = "1d03ebeb73e1a6d426e44a2ccc88b04125ca185ab9d1679817380502a723fa80";
        };
        "bn254_g2.dat" = {
          remote = "g2.dat";
          bytes = 128;
          sha256 = "01797bfc4de5a96f0e516a9ea4537d18786dc30cb991aca4274c95822b69c32f";
        };
        "grumpkin_g1_v2.flat.dat" = {
          remote = "grumpkin_g1_v2.dat";
          bytes = 4194304;
          sha256 = "64236c9455e75aeea77a94587ea607eed2e978d2609a421d66bf10bb9698b8fd";
        };
      };

  gitEntry =
    key:
    assert safeKey key;
    lock.gitDeps.${key}
      or (throw (
        "nargo git dependency ${key} is not in packages/contracts/nix/lock.json; "
        + "run packages/contracts/nix/update-lock.sh with the packages built with Nix"
      ));

  # Only the files nargo compiles: packages/contracts/scripts/build_contracts.sh's target/ and
  # codegen leftovers stay out of the key.
  noirSource =
    dir:
    lib.fileset.toSource {
      root = repo + "/${dir}";
      fileset = lib.fileset.unions [
        (repo + "/${dir}/Nargo.toml")
        (lib.fileset.fileFilter (file: file.hasExt "nr") (repo + "/${dir}/src"))
      ];
    };

  # The script that pins a circuit's verification key on the host, which derives it here.
  generateVk = builtins.path {
    name = "generate-vk.mjs";
    path = repo + "/packages/sdk/scripts/generate-vk.mjs";
  };

  compile =
    {
      dir,
      args ? [ ],
      vk ? false,
    }:
    let
      package = baseNameOf dir;
      contract = (manifest repo dir).package.type or "" == "contract";
      # Runs the npm toolchain, and with it bb.
      toolchain = contract || vk;
      graph = closure repo dir;
      gitKeys = map (x: x.key) (
        builtins.genericClosure {
          startSet = map (dep: { key = gitKey dep; }) graph.gits;
          operator = { key }: map (dep: { key = dep; }) (gitEntry key).deps;
        }
      );
    in
    assert pinsAgree;
    pkgs.stdenv.mkDerivation (
      {
        name = "obsidion-noir-${package}";
        dontUnpack = true;
        nativeBuildInputs = [ nargo ] ++ lib.optional toolchain nodejs;
        buildPhase = ''
          runHook preBuild
          export HOME="$NIX_BUILD_TOP/home"
          ${lib.optionalString toolchain ''
            mkdir -p "$HOME/.bb-crs"
            ${lib.concatMapStrings (c: ''
              cp --no-preserve=mode ${c.file} "$HOME/.bb-crs/${c.name}"
            '') crs}''}
          # Copies, not links: the artifacts record their sources' paths, and a store path in one would drag that
          # source into the output's closure.
          ${lib.concatMapStrings (key: ''
            mkdir -p "$HOME/nargo/$(dirname ${key})"
            cp -r --no-preserve=mode ${fetchGitDep (gitEntry key)} "$HOME/nargo/${key}"
          '') gitKeys}
          ${lib.concatMapStrings (d: ''
            mkdir -p "repo/${d}"
            cp -r --no-preserve=mode ${noirSource d}/. "repo/${d}/"
          '') graph.dirs}
          cd "repo/${dir}"
          ${if contract then "${aztec}/node_modules/.bin/aztec" else "nargo"} compile ${lib.escapeShellArgs args}
          # The artifacts record absolute source paths (debug information only). Outside the sandbox the build
          # directory is random, so name it the way the sandbox does and the output is the same bytes either way.
          sed -i "s#$NIX_BUILD_TOP/#/build/#g" target/*.json
          runHook postBuild
        '';
        installPhase = ''
          mkdir -p $out
          cp target/*.json $out/
        '';
        dontFixup = true;
        allowedReferences = [ ];
      }
      # The verification key as <name>.vk beside the artifact, for the host to pin. The script resolves bb.js from
      # the node_modules beside it. Capped as on the host: Barretenberg has hung deriving it.
      // lib.optionalAttrs vk {
        postBuild = ''
          mkdir -p "$NIX_BUILD_TOP/vk" $out
          cp ${generateVk} "$NIX_BUILD_TOP/vk/generate-vk.mjs"
          ln -s ${aztec}/node_modules "$NIX_BUILD_TOP/vk/node_modules"
          timeout 15m node "$NIX_BUILD_TOP/vk/generate-vk.mjs" --circuit ${package} --in target/${package}.json \
            --vk-out $out/${package}.vk
        '';
      }
    );

  # Each package's build, by directory.
  packages = lib.listToAttrs (map (p: lib.nameValuePair p.dir (compile p)) (builtins.fromJSON spec));
in
{
  inherit aztec nargo packages;
  # The client in-container.sh pushes builds to the Nimbus cache with.
  nimbus = pkgs.stdenv.mkDerivation (finalAttrs: {
    pname = "nimbus";
    version = "0.8.0";
    src = pkgs.fetchurl {
      name = "nimbus-${finalAttrs.version}_Linux_x86_64.tar.gz";
      url = "https://github.com/kclejeune/nimbus/releases/download/v${finalAttrs.version}/nimbus_Linux_x86_64.tar.gz";
      sha256 = "5856b481ff7d44ba839953a8e606927792939af4ef8ec5f5d77479289bafc1fe";
    };
    sourceRoot = ".";
    installPhase = "install -Dm755 nimbus $out/bin/nimbus";
    dontFixup = true;
  });
  # Each package's artifacts at <dir>/target, the way packages/contracts/scripts/build_contracts.sh
  # reads them.
  contracts = pkgs.linkFarm "obsidion-noir-contracts" (
    lib.mapAttrs' (dir: build: lib.nameValuePair "${dir}/target" build) packages
  );
}
