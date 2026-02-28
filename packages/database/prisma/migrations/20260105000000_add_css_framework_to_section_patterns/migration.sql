-- Add CSS Framework fields to section_patterns table
-- Stores detected CSS framework type (tailwind, bootstrap, css_modules, styled_components, vanilla, unknown)
-- and detection metadata with confidence score and evidence

-- Add css_framework column
ALTER TABLE section_patterns
ADD COLUMN css_framework VARCHAR(50);

-- Add css_framework_meta column (JSON with confidence and evidence)
ALTER TABLE section_patterns
ADD COLUMN css_framework_meta JSONB DEFAULT '{}';

-- Add index for css_framework filtering/searching
CREATE INDEX idx_section_patterns_css_framework ON section_patterns(css_framework);

-- Add comment for documentation
COMMENT ON COLUMN section_patterns.css_framework IS 'Detected CSS framework: tailwind, bootstrap, css_modules, styled_components, vanilla, unknown';
COMMENT ON COLUMN section_patterns.css_framework_meta IS 'Detection metadata: { confidence: 0.0-1.0, evidence: string[] }';
