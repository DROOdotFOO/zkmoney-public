#!/usr/bin/env bash
set -e

# Make it usable
# chmod +x packages/contracts/scripts/codegen.sh

# -----------------------------------------------
# Example usage (a name filter matches any contract containing it):
#   ./packages/contracts/scripts/codegen.sh                    # Generate all artifacts
#   ./packages/contracts/scripts/codegen.sh -contract identity # Only identity
#   ./packages/contracts/scripts/codegen.sh -debug             # Enable debug output
#   ./packages/contracts/scripts/codegen.sh -no-transform      # Keep aztec codegen output as-is
#
# It will:
#   1) Find each directory containing Nargo.toml under sdk/contracts.
#   2) Find the JSON file in the compiled artifacts target directory
#   3) Run aztec codegen directly on that JSON file to generate artifacts in .../src/artifacts
#   4) Transform the generated TypeScript to make artifacts injectable (unless -no-transform is set)
# -----------------------------------------------

# Debug mode is disabled by default
DEBUG=0
# Transform mode is enabled by default
TRANSFORM=1

# Parse command line arguments - more flexible parsing
TARGET_CONTRACT=""

# Process all arguments
i=1
while [ $i -le $# ]; do
  arg="${!i}"
  
  # Look for any flag that might indicate a contract name
  if [[ "$arg" == "-contract_name" || "$arg" == "-contract" || "$arg" == "-c" ]]; then
    # Get the next argument as the contract name
    i=$((i+1))
    if [ $i -le $# ]; then
      TARGET_CONTRACT="${!i}"
    fi
  elif [[ "$arg" == "-debug" || "$arg" == "-d" ]]; then
    DEBUG=1
  elif [[ "$arg" == "-no-transform" || "$arg" == "-nt" ]]; then
    TRANSFORM=0
  elif [[ "$arg" == -* && "$arg" != "--" ]]; then
    # Handle case where flag and value are combined (e.g. -paylink_email)
    TARGET_CONTRACT="${arg#-}"
  fi
  
  i=$((i+1))
done

if [[ -n "$TARGET_CONTRACT" ]]; then
  echo "Generating artifacts only for contracts containing: $TARGET_CONTRACT"
else
  echo "Generating artifacts for all contracts"
fi

if [[ "$TRANSFORM" -eq 1 ]]; then
  echo "Artifact transformation: ENABLED (use -no-transform to disable)"
else
  echo "Artifact transformation: DISABLED"
fi

# Clean up all codegenCache.json files first
if [[ "$DEBUG" -eq 1 ]]; then
  echo "Cleaning up all codegenCache.json files..."
fi
find packages/contracts -name "codegenCache.json" -type f -delete

# Define directories to skip codegen
# link_locator: only its artifact is used; a typed wrapper would offer a deploy nobody makes.
SKIP_DIRS=("authenticators/interface" "contracts/link_locator")

# Function to check if CONTRACT_DIR is in SKIP_DIRS
should_skip() {
  local dir="$1"
  for skip_dir in "${SKIP_DIRS[@]}"; do
    if [[ "$dir" == *"$skip_dir"* ]]; then
      return 0  # Skip
    fi
  done
  return 1  # Do not skip
}

# Helper function to get relative path (works on both Linux and macOS)
# Usage: get_relative_path <path> <base>
get_relative_path() {
  local path="$1"
  local base="$2"
  
  # Remove common prefix
  local common_prefix="${path#"$base"}"
  
  # If common_prefix is the same as path, they don't share a common prefix
  if [ "$common_prefix" = "$path" ]; then
    echo "$path"
    return
  fi
  
  # If common_prefix starts with a slash, remove it
  if [[ "$common_prefix" == /* ]]; then
    common_prefix="${common_prefix#/}"
  fi
  
  echo "$common_prefix"
}

# Construct the paths
REPO_ROOT=$(git rev-parse --show-toplevel)
AZTEC_CONTRACTS_DIR="$REPO_ROOT/packages/contracts"
ARTIFACTS_DIR="$AZTEC_CONTRACTS_DIR/src/artifacts"
TRANSFORM_SCRIPT="$REPO_ROOT/packages/contracts/scripts/transform-artifact.cjs"

# Check if aztec command is available
if ! command -v aztec &> /dev/null; then
  echo "ERROR: 'aztec' command not found. Please ensure Aztec CLI is installed and in your PATH."
  exit 1
fi

# Check if transform script exists (only if transform is enabled)
if [[ "$TRANSFORM" -eq 1 ]] && [[ ! -f "$TRANSFORM_SCRIPT" ]]; then
  echo "ERROR: Transform script not found at: $TRANSFORM_SCRIPT"
  exit 1
fi

if [[ "$DEBUG" -eq 1 ]]; then
  echo "Debug: Using aztec codegen command"
  if [[ "$TRANSFORM" -eq 1 ]]; then
    echo "Debug: Using transform script: $TRANSFORM_SCRIPT"
  fi
fi

# Ensure artifacts directory exists
mkdir -p "$ARTIFACTS_DIR"

# Print some debug info
if [[ "$DEBUG" -eq 1 ]]; then
  echo "Debug: Using repo root: $REPO_ROOT"
  echo "Debug: Using aztec contracts directory: $AZTEC_CONTRACTS_DIR"
  echo "Debug: Using artifacts directory: $ARTIFACTS_DIR"
  echo "Debug: Searching for contracts matching: ${TARGET_CONTRACT:-'all contracts'}"
fi

# Track success/failure counts
TOTAL_CONTRACTS=0
SUCCESSFUL_CONTRACTS=0
FAILED_CONTRACTS=0

# Progress spinner characters
SPINNER=('-' '\' '|' '/')

# 1) Find each folder that has Nargo.toml
for NARGO_FILE in $(find packages/contracts/contracts -type f -name "Nargo.toml" -not -path '*/node_modules/*' -not -path '*/libs/*' -not -path '*/lib/*' -not -path '*/.git/*'); do
  CONTRACT_DIR=$(dirname "$NARGO_FILE")
  
  if [[ "$DEBUG" -eq 1 ]]; then
    echo "Debug: Found contract at $CONTRACT_DIR"
  fi
  
  # Skip if we're targeting a specific contract and this isn't it
  if [[ -n "$TARGET_CONTRACT" && ! "$CONTRACT_DIR" == *"$TARGET_CONTRACT"* ]]; then
    if [[ "$DEBUG" -eq 1 ]]; then
      echo "Debug: Skipping because it doesn't match the target: $TARGET_CONTRACT"
    fi
    continue
  fi

  # Skip if we should skip this directory
  if should_skip "$CONTRACT_DIR"; then
    if [[ "$DEBUG" -eq 1 ]]; then
      echo "Skipping codegen for: $CONTRACT_DIR"
    fi
    continue
  fi

  TOTAL_CONTRACTS=$((TOTAL_CONTRACTS + 1))
  CONTRACT_NAME=$(basename "$CONTRACT_DIR")
  
  # Show a simple progress indicator
  if [[ "$DEBUG" -eq 0 ]]; then
    SPIN_IDX=$((TOTAL_CONTRACTS % 4))
    echo -ne "Generating artifacts ${SPINNER[$SPIN_IDX]} $CONTRACT_NAME\r"
  else
    echo "============================================================"
    echo "Generating artifacts for: $CONTRACT_DIR"
    echo "============================================================"
  fi

  # Get the absolute path of the contract directory
  ABSOLUTE_CONTRACT_DIR=$(cd "$CONTRACT_DIR" && pwd)
  
  # Use the compiled artifacts target directory
  TARGET_DIR="$ARTIFACTS_DIR/target/$CONTRACT_NAME"
  
  if [[ "$DEBUG" -eq 1 ]]; then
    echo "Debug: Absolute contract directory: $ABSOLUTE_CONTRACT_DIR"
    echo "Debug: Target directory: $TARGET_DIR"
  fi

  # Find the appropriate JSON file in the target directory
  if [ -d "$TARGET_DIR" ]; then
    # Look for non-backup JSON files in the target directory
    JSON_FILES=$(find "$TARGET_DIR" -name "*.json" -not -name "*.bak" | sort)
    JSON_COUNT=$(echo "$JSON_FILES" | grep -v '^$' | wc -l | tr -d ' ')
    
    if [[ "$DEBUG" -eq 1 ]]; then
      echo "Debug: Found $JSON_COUNT JSON files in target directory"
      echo "$JSON_FILES"
    fi
    
    if [ -n "$JSON_FILES" ] && [ "$JSON_COUNT" -gt 0 ]; then
      # Use the first JSON file if multiple exist
      CONTRACT_JSON=$(echo "$JSON_FILES" | head -1)
      
      if [[ "$DEBUG" -eq 1 ]]; then
        echo "Debug: Using JSON file: $CONTRACT_JSON"
        echo "Debug: JSON file exists: $([ -f "$CONTRACT_JSON" ] && echo "Yes" || echo "No")"
      fi
      
      # Remove codegenCache.json if it exists
      if [ -f "$ABSOLUTE_CONTRACT_DIR/codegenCache.json" ]; then
        rm "$ABSOLUTE_CONTRACT_DIR/codegenCache.json"
      fi
      
      # Run codegen with error handling - if it fails, log the error but continue
      if [[ "$DEBUG" -eq 1 ]]; then
        echo "Running aztec codegen for: $CONTRACT_DIR"
      fi
      
      # Use aztec codegen command
      CODEGEN_CMD="aztec codegen \"$CONTRACT_JSON\" -o \"$ARTIFACTS_DIR\""
      
      if [[ "$DEBUG" -eq 1 ]]; then
        echo "Debug: Running command: $CODEGEN_CMD"
      fi
      
      # Capture output to reduce clutter in non-debug mode
      if [[ "$DEBUG" -eq 1 ]]; then
        if eval $CODEGEN_CMD; then
          # Extract contract class name from JSON filename (e.g., "obsidion_account-ObsidionAccount.json" -> "ObsidionAccount")
          JSON_BASENAME=$(basename "$CONTRACT_JSON")
          CONTRACT_CLASS_NAME="${JSON_BASENAME##*-}"
          CONTRACT_CLASS_NAME="${CONTRACT_CLASS_NAME%.json}"
          GENERATED_TS="$ARTIFACTS_DIR/${CONTRACT_CLASS_NAME}.ts"
          
          # Run transform if enabled and file exists
          if [[ "$TRANSFORM" -eq 1 ]] && [[ -f "$GENERATED_TS" ]]; then
            echo "Transforming artifact: $GENERATED_TS"
            if node "$TRANSFORM_SCRIPT" "$GENERATED_TS"; then
              echo "Successfully transformed: ${CONTRACT_CLASS_NAME}.ts"
            else
              echo "WARNING: Transform failed for ${CONTRACT_CLASS_NAME}.ts"
            fi
          fi
          
          SUCCESSFUL_CONTRACTS=$((SUCCESSFUL_CONTRACTS + 1))
          echo "Successfully generated artifacts for: $CONTRACT_DIR"
        else
          FAILED_CONTRACTS=$((FAILED_CONTRACTS + 1))
          echo "WARNING: Codegen failed for $CONTRACT_DIR but continuing with other contracts"
        fi
      else
        if OUTPUT=$(eval $CODEGEN_CMD 2>&1); then
          # Extract contract class name from JSON filename (e.g., "obsidion_account-ObsidionAccount.json" -> "ObsidionAccount")
          JSON_BASENAME=$(basename "$CONTRACT_JSON")
          CONTRACT_CLASS_NAME="${JSON_BASENAME##*-}"
          CONTRACT_CLASS_NAME="${CONTRACT_CLASS_NAME%.json}"
          GENERATED_TS="$ARTIFACTS_DIR/${CONTRACT_CLASS_NAME}.ts"
          
          # Run transform if enabled and file exists
          if [[ "$TRANSFORM" -eq 1 ]] && [[ -f "$GENERATED_TS" ]]; then
            if TRANSFORM_OUTPUT=$(node "$TRANSFORM_SCRIPT" "$GENERATED_TS" 2>&1); then
              if [[ "$DEBUG" -eq 1 ]]; then
                echo "$TRANSFORM_OUTPUT"
              fi
            else
              echo -e "\nWARNING: Transform failed for ${CONTRACT_CLASS_NAME}.ts"
              echo "$TRANSFORM_OUTPUT" | head -3
            fi
          fi
          
          SUCCESSFUL_CONTRACTS=$((SUCCESSFUL_CONTRACTS + 1))
        else
          FAILED_CONTRACTS=$((FAILED_CONTRACTS + 1))
          echo -e "\nWARNING: Codegen failed for $CONTRACT_NAME"
          echo "$OUTPUT" | grep -E "Error|error|Exception|exception|Failed|failed" | head -3
        fi
      fi
    else
      FAILED_CONTRACTS=$((FAILED_CONTRACTS + 1))
      if [[ "$DEBUG" -eq 1 ]]; then
        echo "WARNING: No JSON files found in target directory for $CONTRACT_DIR"
      else
        echo -e "\nWARNING: No JSON files found for $CONTRACT_NAME"
      fi
    fi
  else
    FAILED_CONTRACTS=$((FAILED_CONTRACTS + 1))
    if [[ "$DEBUG" -eq 1 ]]; then
      echo "WARNING: No target directory found for $CONTRACT_DIR"
    else
      echo -e "\nWARNING: No target directory found for $CONTRACT_NAME"
    fi
  fi
done  

# Clear the progress line
echo -ne "                                                               \r"

# Print summary
echo "============================================================"
echo "CODEGEN SUMMARY"
echo "============================================================"
echo "Total contracts processed: $TOTAL_CONTRACTS"
echo "Successfully generated: $SUCCESSFUL_CONTRACTS"

if [ "$FAILED_CONTRACTS" -gt 0 ]; then
  echo "Failed: $FAILED_CONTRACTS"
fi

if [[ -n "$TARGET_CONTRACT" ]]; then
  if [ "$SUCCESSFUL_CONTRACTS" -gt 0 ]; then
    echo "Successfully generated artifacts for contracts containing: $TARGET_CONTRACT"
  else
    echo "No artifacts were generated for contracts containing: $TARGET_CONTRACT"
  fi
else
  if [ "$SUCCESSFUL_CONTRACTS" -gt 0 ]; then
    echo "Successfully generated artifacts for $SUCCESSFUL_CONTRACTS contracts"
  else
    echo "No artifacts were generated"
  fi
fi

# Return success if at least one contract was processed successfully
if [ "$SUCCESSFUL_CONTRACTS" -gt 0 ]; then
  exit 0
else
  exit 1
fi
