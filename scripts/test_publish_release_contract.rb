#!/usr/bin/env ruby
# frozen_string_literal: true

require 'yaml'

WORKFLOW = File.expand_path('../.github/workflows/publish-oxide-relayer.yml', __dir__)
CHECKOUT = 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262'
ADMITTED_SOURCE = '${{ needs.admission.outputs.source-commit }}'
ADMISSION_OUTPUT = '${{ steps.admit.outputs.source-commit }}'

class ContractFailure < StandardError; end

def fail_contract(message)
  raise ContractFailure, message
end

def publish_steps(workflow)
  jobs = workflow.fetch('jobs') { fail_contract('workflow jobs are missing') }
  publish = jobs.fetch('publish-release') { fail_contract('publish-release job is missing') }
  steps = publish.fetch('steps') { fail_contract('publish-release steps are missing') }
  fail_contract('publish-release steps have the wrong type') unless steps.is_a?(Array)
  steps
end

def validate(workflow)
  jobs = workflow.fetch('jobs') { fail_contract('workflow jobs are missing') }
  admission_outputs = jobs.fetch('admission').fetch('outputs')
  unless admission_outputs['source-commit'] == ADMISSION_OUTPUT
    fail_contract('admission does not expose the exact source commit')
  end

  steps = publish_steps(workflow)
  checkout_indexes = steps.each_index.select { |index| steps[index]['uses'] == CHECKOUT }
  fail_contract('publish-release requires exactly one pinned checkout') unless checkout_indexes.length == 1
  checkout_index = checkout_indexes.first
  checkout = steps.fetch(checkout_index)
  checkout_with = checkout.fetch('with') { fail_contract('publish checkout inputs are missing') }
  fail_contract('publish checkout uses a moving or default ref') unless checkout_with['ref'] == ADMITTED_SOURCE
  fail_contract('publish checkout fetch depth is not minimal') unless checkout_with['fetch-depth'] == 1
  unless checkout_with['persist-credentials'] == false
    fail_contract('publish checkout persists credentials')
  end

  verify_indexes = steps.each_index.select { |index| steps[index]['id'] == 'verify-source' }
  fail_contract('publish-release requires exactly one source verification step') unless verify_indexes.length == 1
  verify_index = verify_indexes.first
  verify_step = steps.fetch(verify_index)
  verify_run = verify_step['run']
  unless verify_run.is_a?(String) && verify_run.include?('python3 -B scripts/verify_publish_source.py')
    fail_contract('publish source verification does not execute the repository verifier')
  end
  verify_env = verify_step.fetch('env') { fail_contract('publish source verification environment is missing') }
  unless verify_env['ADMITTED_SOURCE_COMMIT'] == ADMITTED_SOURCE
    fail_contract('publish source verification is not bound to the admitted commit')
  end

  publish_indexes = steps.each_index.select { |index| steps[index]['id'] == 'publish-release' }
  fail_contract('publish-release requires exactly one publication boundary step') unless publish_indexes.length == 1
  publish_index = publish_indexes.first
  fail_contract('checkout occurs after source verification') unless checkout_index < verify_index
  fail_contract('source verification occurs after release creation') unless verify_index < publish_index

  steps.each_with_index do |step, index|
    run = step['run']
    next unless run.is_a?(String) && run.match?(%r{(?:^|\s)scripts/})
    fail_contract("repository script runs before checkout at step #{index}") unless checkout_index < index
  end

  release_create_count = jobs.values.sum do |job|
    Array(job['steps']).sum do |step|
      run = step['run']
      run.is_a?(String) ? run.scan(/\bgh\s+release\s+create\b/).length : 0
    end
  end
  fail_contract('workflow must contain exactly one release-create boundary') unless release_create_count == 1

  verifier = File.expand_path('verify_immutable_release_attestation.py', __dir__)
  fail_contract('repository release verifier is missing') unless File.file?(verifier) && !File.symlink?(verifier)
end

def expect_failure(workflow, message)
  validate(workflow)
  raise "mutation unexpectedly passed: #{message}"
rescue ContractFailure => error
  raise "wrong failure for #{message}: #{error.message}" unless error.message.include?(message)
end

workflow = YAML.safe_load(File.read(WORKFLOW), aliases: false)
validate(workflow)

without_checkout = Marshal.load(Marshal.dump(workflow))
without_checkout_steps = publish_steps(without_checkout)
without_checkout_steps.reject! { |step| step['uses'] == CHECKOUT }
expect_failure(without_checkout, 'pinned checkout')

late_checkout = Marshal.load(Marshal.dump(workflow))
late_steps = publish_steps(late_checkout)
checkout = late_steps.delete_at(late_steps.index { |step| step['uses'] == CHECKOUT })
publish_index = late_steps.index { |step| step['id'] == 'publish-release' }
late_steps.insert(publish_index + 1, checkout)
expect_failure(late_checkout, 'checkout occurs after')

moving_checkout = Marshal.load(Marshal.dump(workflow))
moving_step = publish_steps(moving_checkout).find { |step| step['uses'] == CHECKOUT }
moving_step['with']['ref'] = '${{ github.ref }}'
expect_failure(moving_checkout, 'moving or default ref')

wrong_admission = Marshal.load(Marshal.dump(workflow))
wrong_admission['jobs']['admission']['outputs']['source-commit'] = '${{ github.sha }}'
expect_failure(wrong_admission, 'does not expose')

without_verification = Marshal.load(Marshal.dump(workflow))
without_verification_steps = publish_steps(without_verification)
without_verification_steps.reject! { |step| step['id'] == 'verify-source' }
expect_failure(without_verification, 'source verification step')

duplicate_publication = Marshal.load(Marshal.dump(workflow))
duplicate_step = publish_steps(duplicate_publication).find { |step| step['id'] == 'publish-release' }
duplicate_step['run'] += "\ngh release create duplicate\n"
expect_failure(duplicate_publication, 'exactly one release-create')

puts 'publish-release structural and ordering contract: PASS'
