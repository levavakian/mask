{
  description = "Mask Morph: a web app that morphs your face on a Shining Mask over Bluetooth";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      tools = pkgs: rec {
        # Serve the static site from docs/ (localhost counts as a secure context,
        # so camera and Bluetooth work in a desktop browser).
        serve = pkgs.writeShellApplication {
          name = "serve";
          runtimeInputs = [ pkgs.python3 ];
          text = ''
            port="''${PORT:-8000}"
            echo "Serving docs/ at http://localhost:$port"
            exec python3 -m http.server "$port" --bind 127.0.0.1 -d docs
          '';
        };

        # Unit tests for the mask protocol, encryption and image encoding.
        test = pkgs.writeShellApplication {
          name = "test";
          runtimeInputs = [ pkgs.nodejs ];
          text = ''exec node --test tests/*.test.mjs'';
        };

        # Headless browser check: loads the app, feeds it tests/fixtures/selfie.jpg,
        # and saves screenshots to tests/out/. Needs internet (face model is on a CDN).
        e2e = pkgs.writeShellApplication {
          name = "e2e";
          runtimeInputs = [ (pkgs.python3.withPackages (p: [ p.playwright ])) ];
          text = ''
            # nixpkgs' Chromium has working software WebGL, which the face model needs.
            export CHROMIUM=${pkgs.chromium}/bin/chromium
            export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
            exec python3 tests/e2e.py "$@"
          '';
        };
      };
    in
    {
      packages = forAll (pkgs: tools pkgs // { default = (tools pkgs).serve; });

      apps = forAll (pkgs: nixpkgs.lib.mapAttrs
        (_: drv: { type = "app"; program = nixpkgs.lib.getExe drv; })
        (tools pkgs // { default = (tools pkgs).serve; }));

      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = [ pkgs.nodejs pkgs.python3 pkgs.gh ];
        };
      });
    };
}
