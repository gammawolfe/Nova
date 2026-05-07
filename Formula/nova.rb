# Formula/nova.rb — Homebrew formula for the Nova CLI
#
# To use before the tap is published:
#   brew install --formula Formula/nova.rb
#
# After publishing the tap (C2):
#   brew tap gammawolfe/nova
#   brew install nova

class Nova < Formula
  desc "Operator CLI for Nova zero-trust agent gateway"
  homepage "https://github.com/gammawolfe/Nova"
  version "0.1.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/gammawolfe/Nova/releases/download/v0.1.0/nova-macos-arm64"
      sha256 "PLACEHOLDER_ARM64_SHA256"
    end
    on_intel do
      url "https://github.com/gammawolfe/Nova/releases/download/v0.1.0/nova-macos-x64"
      sha256 "PLACEHOLDER_X64_SHA256"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/gammawolfe/Nova/releases/download/v0.1.0/nova-linux-x64"
      sha256 "PLACEHOLDER_LINUX_SHA256"
    end
  end

  def install
    # The downloaded asset IS the binary — just rename and install it
    binary_name = if OS.mac? && Hardware::CPU.arm?
      "nova-macos-arm64"
    elsif OS.mac?
      "nova-macos-x64"
    else
      "nova-linux-x64"
    end

    # When downloaded via Homebrew the file arrives with the asset name
    # Rename to 'nova' and mark executable
    mv binary_name, "nova" if File.exist?(binary_name)
    chmod 0755, "nova"
    bin.install "nova"
  end

  test do
    assert_match "v#{version}", shell_output("#{bin}/nova --version")
    assert_match "nova setup", shell_output("#{bin}/nova --help")
  end
end
