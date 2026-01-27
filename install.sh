#!/bin/sh
set -e

# wct installation script
# Automatically detects platform and installs the appropriate binary

# Colors for output
if [ -t 1 ]; then
	RED='\033[0;31m'
	GREEN='\033[0;32m'
	YELLOW='\033[1;33m'
	BLUE='\033[0;34m'
	NC='\033[0m' # No Color
else
	RED=''
	GREEN=''
	YELLOW=''
	BLUE=''
	NC=''
fi

# Configuration
REPO="dmtr-p/tab-cli"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
BINARY_NAME="wct"

# Cleanup function
cleanup() {
	if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
		rm -rf "$TEMP_DIR"
	fi
}

# Set trap to cleanup on exit
trap cleanup EXIT INT TERM

# Print functions
print_info() {
	printf "${BLUE}%s${NC}\n" "$1"
}

print_success() {
	printf "${GREEN}✓${NC} %s\n" "$1"
}

print_error() {
	printf "${RED}✗${NC} %s\n" "$1" >&2
}

print_warning() {
	printf "${YELLOW}!${NC} %s\n" "$1"
}

# Detect platform and architecture
detect_platform() {
	OS=$(uname -s | tr '[:upper:]' '[:lower:]')
	ARCH=$(uname -m)

	# Normalize architecture names
	case "$ARCH" in
		x86_64)
			ARCH="x64"
			;;
		aarch64)
			ARCH="arm64"
			;;
		arm64)
			ARCH="arm64"
			;;
		*)
			print_error "Unsupported architecture: $ARCH"
			print_info "Supported architectures: x64, arm64"
			exit 1
			;;
	esac

	# Validate OS
	case "$OS" in
		darwin|linux)
			;;
		*)
			print_error "Unsupported operating system: $OS"
			print_info "Supported platforms: macOS (darwin), Linux"
			exit 1
			;;
	esac

	PLATFORM="${OS}-${ARCH}"
	print_success "Platform: $PLATFORM"
}

# Check for required tools
check_requirements() {
	# Check for curl or wget
	if command -v curl >/dev/null 2>&1; then
		DOWNLOADER="curl"
	elif command -v wget >/dev/null 2>&1; then
		DOWNLOADER="wget"
	else
		print_error "Neither curl nor wget found"
		print_info "Please install curl or wget and try again"
		exit 1
	fi
}

# Download file
download_file() {
	url="$1"
	output="$2"

	if [ "$DOWNLOADER" = "curl" ]; then
		curl -fsSL "$url" -o "$output"
	else
		wget -q "$url" -O "$output"
	fi
}

# Download and verify binary
download_binary() {
	print_info "Downloading wct..."

	TEMP_DIR=$(mktemp -d)
	BINARY_FILE="wct-${PLATFORM}"
	BINARY_URL="https://github.com/${REPO}/releases/latest/download/${BINARY_FILE}"
	CHECKSUM_URL="https://github.com/${REPO}/releases/latest/download/checksums.txt"

	# Download binary
	if ! download_file "$BINARY_URL" "$TEMP_DIR/$BINARY_FILE"; then
		print_error "Failed to download binary from $BINARY_URL"
		print_info "Please check your internet connection and try again"
		exit 1
	fi

	# Get file size
	if command -v stat >/dev/null 2>&1; then
		if stat -f%z "$TEMP_DIR/$BINARY_FILE" >/dev/null 2>&1; then
			# macOS
			SIZE=$(stat -f%z "$TEMP_DIR/$BINARY_FILE")
		else
			# Linux
			SIZE=$(stat -c%s "$TEMP_DIR/$BINARY_FILE")
		fi
		SIZE_MB=$((SIZE / 1024 / 1024))
		print_success "Downloaded $BINARY_FILE (${SIZE_MB} MB)"
	else
		print_success "Downloaded $BINARY_FILE"
	fi

	# Download and verify checksum (unless skipped)
	if [ "${SKIP_CHECKSUM:-0}" != "1" ]; then
		print_info "Verifying checksum..."

		if ! download_file "$CHECKSUM_URL" "$TEMP_DIR/checksums.txt"; then
			print_warning "Failed to download checksums, skipping verification"
		else
			# Extract expected checksum for this platform
			EXPECTED_CHECKSUM=$(grep "$BINARY_FILE" "$TEMP_DIR/checksums.txt" | awk '{print $1}')

			if [ -z "$EXPECTED_CHECKSUM" ]; then
				print_warning "No checksum found for $BINARY_FILE, skipping verification"
			else
				# Calculate actual checksum
				if command -v shasum >/dev/null 2>&1; then
					ACTUAL_CHECKSUM=$(shasum -a 256 "$TEMP_DIR/$BINARY_FILE" | awk '{print $1}')
				elif command -v sha256sum >/dev/null 2>&1; then
					ACTUAL_CHECKSUM=$(sha256sum "$TEMP_DIR/$BINARY_FILE" | awk '{print $1}')
				else
					print_warning "No SHA256 tool found (shasum/sha256sum), skipping verification"
					ACTUAL_CHECKSUM=""
				fi

				if [ -n "$ACTUAL_CHECKSUM" ]; then
					if [ "$EXPECTED_CHECKSUM" = "$ACTUAL_CHECKSUM" ]; then
						print_success "Checksum verified"
					else
						print_error "Checksum mismatch!"
						print_error "Expected: $EXPECTED_CHECKSUM"
						print_error "Got:      $ACTUAL_CHECKSUM"
						exit 1
					fi
				fi
			fi
		fi
	else
		print_warning "Skipping checksum verification (SKIP_CHECKSUM=1)"
	fi
}

# Check for existing installation
check_existing() {
	INSTALL_PATH="$INSTALL_DIR/$BINARY_NAME"

	if [ -f "$INSTALL_PATH" ]; then
		print_info "Checking for existing installation..."

		if [ -x "$INSTALL_PATH" ]; then
			CURRENT_VERSION=$("$INSTALL_PATH" --version 2>/dev/null || echo "unknown")
			print_info "Found wct $CURRENT_VERSION at $INSTALL_PATH"

			printf "Upgrade to latest version? [y/N]: "
			read -r REPLY
			case "$REPLY" in
				[Yy]*)
					# Backup existing binary
					BACKUP_PATH="${INSTALL_PATH}.backup"
					cp "$INSTALL_PATH" "$BACKUP_PATH" 2>/dev/null || true
					print_info "Backed up existing binary to ${BACKUP_PATH}"
					;;
				*)
					print_info "Installation cancelled"
					exit 0
					;;
			esac
		fi
	fi
}

# Install binary
install_binary() {
	print_info "Installing to $INSTALL_DIR..."

	INSTALL_PATH="$INSTALL_DIR/$BINARY_NAME"
	BINARY_FILE="wct-${PLATFORM}"

	# Check if install directory exists
	if [ ! -d "$INSTALL_DIR" ]; then
		print_error "Install directory does not exist: $INSTALL_DIR"
		print_info "Please create it or set INSTALL_DIR to a different location"
		exit 1
	fi

	# Check if we can write to install directory
	if [ ! -w "$INSTALL_DIR" ]; then
		print_info "Installing to $INSTALL_DIR requires elevated privileges"

		# Try with sudo
		if command -v sudo >/dev/null 2>&1; then
			if ! sudo cp "$TEMP_DIR/$BINARY_FILE" "$INSTALL_PATH"; then
				print_error "Failed to install binary"
				exit 1
			fi
			if ! sudo chmod +x "$INSTALL_PATH"; then
				print_error "Failed to make binary executable"
				exit 1
			fi
		else
			print_error "Cannot write to $INSTALL_DIR and sudo is not available"
			print_info "Please run with appropriate permissions or set INSTALL_DIR to a writable location"
			exit 1
		fi
	else
		# Direct installation
		if ! cp "$TEMP_DIR/$BINARY_FILE" "$INSTALL_PATH"; then
			print_error "Failed to install binary"
			exit 1
		fi
		if ! chmod +x "$INSTALL_PATH"; then
			print_error "Failed to make binary executable"
			exit 1
		fi
	fi

	print_success "Installed successfully"
}

# Verify installation
verify_installation() {
	print_info "Testing installation..."

	INSTALL_PATH="$INSTALL_DIR/$BINARY_NAME"

	if ! command -v "$BINARY_NAME" >/dev/null 2>&1 && [ ! -x "$INSTALL_PATH" ]; then
		print_error "Installation verification failed"
		print_info "Binary installed to $INSTALL_PATH but not found in PATH"
		exit 1
	fi

	VERSION_OUTPUT=$("$INSTALL_PATH" --version 2>&1 || echo "")
	if [ -n "$VERSION_OUTPUT" ]; then
		print_success "$VERSION_OUTPUT"
	else
		print_warning "Could not verify version"
	fi
}

# Main installation flow
main() {
	echo ""
	print_info "wct installer"
	echo ""

	detect_platform
	check_requirements
	download_binary
	check_existing
	install_binary
	verify_installation

	echo ""
	print_success "Installation complete!"
	print_info "Try: wct --help"
	echo ""

	# Check if installed location is in PATH
	case ":$PATH:" in
		*":$INSTALL_DIR:"*)
			# In PATH, all good
			;;
		*)
			print_warning "$INSTALL_DIR is not in your PATH"
			print_info "Add it to your PATH or use the full path: $INSTALL_DIR/$BINARY_NAME"
			;;
	esac
}

main
