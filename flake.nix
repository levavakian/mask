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

        # Photo or video from the laptop webcam, to see what the mask is showing. WSL only: it runs
        # tools/webcam.ps1 in Windows PowerShell, which uses the camera API built into Windows.
        webcam = pkgs.writeShellApplication {
          name = "webcam";
          runtimeInputs = [ pkgs.coreutils ];
          text = ''
            usage() {
              cat <<'EOF'
            Usage: webcam photo [FILE.png|FILE.jpg] [options]
                   webcam video [FILE.mp4] [--seconds N] [options]
                   webcam list
            Options:
              --exposure auto|-13..-1  exposure as log2(seconds), e.g. -8 = 1/256 s; short ones keep LEDs from saturating
              --size WxH               frame size (default: the largest, 1920x1080 here)
              --camera NAME            part of the camera's name (default: the first camera)
            FILE defaults to tests/out/webcam/<mode>-<time>.<ext> (git-ignored).
            EOF
            }
            mode="''${1:-}"
            case "$mode" in
              photo | video | list) shift ;;
              -h | --help) usage; exit 0 ;;
              *) usage >&2; exit 1 ;;
            esac

            out=""
            opts=()
            while [ $# -gt 0 ]; do
              case "$1" in
                --exposure | --size | --camera | --seconds)
                  [ $# -ge 2 ] || { echo "webcam: $1 needs a value" >&2; exit 1; }
                  name="''${1#--}"
                  opts+=("-''${name^}" "$2")
                  shift 2 ;;
                -h | --help) usage; exit 0 ;;
                -*) echo "webcam: unknown option $1" >&2; exit 1 ;;
                *) out="$1"; shift ;;
              esac
            done

            if command -v powershell.exe >/dev/null 2>&1; then
              ps=powershell.exe
            elif [ -x /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]; then
              ps=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
            else
              echo "webcam: needs WSL on Windows (powershell.exe not found)" >&2
              exit 1
            fi

            if [ "$mode" != list ]; then
              if [ -z "$out" ]; then
                ext=png; [ "$mode" = video ] && ext=mp4
                out="tests/out/webcam/$mode-$(date +%Y%m%d-%H%M%S).$ext"
              fi
              out="$(realpath -m "$out")"
              mkdir -p "$(dirname "$out")"
              opts+=(-Out "$(wslpath -w "$out")")
            fi

            "$ps" -MTA -NoProfile -NonInteractive -ExecutionPolicy Bypass \
              -File "$(wslpath -w ${./tools/webcam.ps1})" -Mode "$mode" "''${opts[@]}" | tr -d '\r'
            if [ "$mode" != list ]; then echo "$out"; fi
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
          # ffmpeg is for pulling frames out of webcam clips.
          packages = [ pkgs.nodejs pkgs.python3 pkgs.gh pkgs.ffmpeg-headless ];
        };
      });
    };
}
