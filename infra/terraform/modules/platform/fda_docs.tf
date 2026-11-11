# FDA document bucket (F1.2, ADR-017): public 510(k) summary PDFs that fda-worker fetches
# once from accessdata.fda.gov. Kept apart from the client bucket: nothing here is
# customer data, and only fda-worker can write it. Private like every bucket here, even
# though the PDFs themselves are public FDA records.

resource "aws_s3_bucket" "fda_docs" {
  bucket        = "${local.name}-fda-docs-${local.account_id}"
  force_destroy = !var.deletion_protection
}

resource "aws_s3_bucket_public_access_block" "fda_docs" {
  bucket                  = aws_s3_bucket.fda_docs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "fda_docs" {
  bucket = aws_s3_bucket.fda_docs.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "fda_docs" {
  bucket = aws_s3_bucket.fda_docs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# fda-worker fetches and reads the PDFs (parse step); the API only reports status from fda_db.
data "aws_iam_policy_document" "fda_worker_docs" {
  statement {
    sid       = "FdaDocsObjects"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.fda_docs.arn}/*"]
  }
  statement {
    sid       = "FdaDocsList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.fda_docs.arn]
  }
}

resource "aws_iam_role_policy" "fda_worker_docs" {
  name   = "fda-docs"
  role   = aws_iam_role.fda_task["fda-worker"].id
  policy = data.aws_iam_policy_document.fda_worker_docs.json
}
