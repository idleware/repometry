package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
)

const structuresContract = "repometry.code-structures/v1"

type processRequest struct {
	Settings struct {
		Duplication duplicationSettings `json:"duplication"`
	} `json:"settings"`
	Inputs struct {
		Files struct {
			Files []struct {
				Path string `json:"path"`
			} `json:"files"`
		} `json:"files"`
	} `json:"inputs"`
}

type codeStructure struct {
	Path                string               `json:"path"`
	Lines               int                  `json:"lines"`
	Functions           int                  `json:"functions"`
	CyclomaticFunctions []functionComplexity `json:"cyclomaticFunctions"`
	CognitiveComplexity int                  `json:"cognitiveComplexity"`
	CognitiveFunctions  []functionComplexity `json:"cognitiveFunctions"`
	Observations        []observation        `json:"observations"`
	Clones              cloneSource          `json:"clones"`
	CommentLines        int                  `json:"commentLines"`
	CodeLines           []int                `json:"codeLines"`
}

type functionComplexity struct {
	Name   string `json:"name,omitempty"`
	Line   int    `json:"line"`
	Column int    `json:"column"`
	Value  int    `json:"value"`
}

type observation struct {
	Rule    string `json:"rule"`
	Value   int    `json:"value"`
	Label   string `json:"label"`
	Line    int    `json:"line"`
	EndLine int    `json:"endLine"`
	Anchor  string `json:"anchor,omitempty"`
}

type duplicationSettings struct {
	MinCodeLines int `json:"minCodeLines"`
	MinNodes     int `json:"minNodes"`
}

type cloneSource struct {
	Path       string      `json:"path"`
	Scheme     string      `json:"scheme"`
	CodeLines  []int       `json:"codeLines"`
	Candidates []candidate `json:"candidates"`
}

type candidate struct {
	Start     int    `json:"start"`
	End       int    `json:"end"`
	Line      int    `json:"line"`
	EndLine   int    `json:"endLine"`
	CodeLines int    `json:"codeLines"`
	Nodes     int    `json:"nodes"`
	Exact     string `json:"exact"`
	Similar   string `json:"similar"`
}

type span struct {
	start, end int
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	var request processRequest
	request.Settings.Duplication = duplicationSettings{MinCodeLines: 12, MinNodes: 50}
	if err := json.NewDecoder(os.Stdin).Decode(&request); err != nil {
		return fmt.Errorf("read Go parser request: %w", err)
	}

	response := json.NewEncoder(os.Stdout)
	files := request.Inputs.Files.Files
	structures := make([]codeStructure, 0, len(files))
	for _, file := range files {
		structure, err := inspectFile(file.Path, request.Settings.Duplication)
		if err != nil {
			if err := response.Encode(map[string]any{
				"kind": "diagnostic", "severity": "warning", "message": err.Error(),
			}); err != nil {
				return err
			}
			continue
		}
		structures = append(structures, structure)
	}
	return response.Encode(map[string]any{
		"kind": "product", "contract": structuresContract, "value": structures,
	})
}

func inspectFile(path string, duplication duplicationSettings) (codeStructure, error) {
	source, err := os.ReadFile(filepath.FromSlash(path))
	if err != nil {
		return codeStructure{}, fmt.Errorf("Unable to read Go source %q", path)
	}
	positions := token.NewFileSet()
	file, err := parser.ParseFile(positions, path, source, parser.ParseComments|parser.SkipObjectResolution)
	if err != nil {
		return codeStructure{}, fmt.Errorf("Unable to parse Go source %q", path)
	}

	layout := sourceLayout{tokens: positions.File(file.Pos()), offsets: lineOffsets(source), source: source}
	layout.fixRawStringEnds(file)
	code, comments := classifyLines(source, layout.offsets, commentSpans(file, layout.tokens, source))
	metrics := measureStructure(file, layout)
	return codeStructure{
		Path: path, Lines: len(layout.offsets) - 1, Functions: len(metrics.cyclomatic),
		CyclomaticFunctions: metrics.cyclomatic, CognitiveComplexity: metrics.cognitiveTotal,
		CognitiveFunctions: metrics.cognitive, Observations: metrics.observations,
		CommentLines: comments, CodeLines: code, Clones: measureClones(path, file, layout, code, duplication),
	}, nil
}

// Repometry recognizes these line breaks in every source inventory.
func lineOffsets(source []byte) []int {
	offsets := []int{0}
	for offset, char := range string(source) {
		switch char {
		case '\r':
			if offset+1 == len(source) || source[offset+1] != '\n' {
				offsets = append(offsets, offset+1)
			}
		case '\n':
			offsets = append(offsets, offset+1)
		case '\u2028', '\u2029':
			offsets = append(offsets, offset+len(string(char)))
		}
	}
	if offsets[len(offsets)-1] != len(source) {
		offsets = append(offsets, len(source))
	}
	return offsets
}

func commentSpans(file *ast.File, tokens *token.File, source []byte) []span {
	var spans []span
	for _, group := range file.Comments {
		for _, comment := range group.List {
			start := tokens.Offset(comment.Slash)
			// The AST comment text omits carriage returns, so find its end in the original source.
			end := len(source)
			if source[start+1] == '/' {
				if newline := bytes.IndexByte(source[start:], '\n'); newline >= 0 {
					end = start + newline
				}
			} else {
				end = start + 4 + bytes.Index(source[start+2:], []byte("*/"))
			}
			spans = append(spans, span{start, end})
		}
	}
	return spans
}

func classifyLines(source []byte, offsets []int, comments []span) ([]int, int) {
	code := []int{}
	commentLines := 0
	start := 0
	if bytes.HasPrefix(source, []byte("\ufeff")) {
		start = len("\ufeff")
	}
	for line, end := range offsets[1:] {
		cursor := start
		hasCode, hasComment := false, false
		for len(comments) > 0 && comments[0].start < end {
			comment := comments[0]
			hasComment = true
			if cursor < comment.start {
				hasCode = hasCode || len(bytes.TrimSpace(source[cursor:comment.start])) > 0
			}
			cursor = comment.end
			if cursor > end {
				break
			}
			comments = comments[1:]
		}
		if hasCode || (cursor < end && len(bytes.TrimSpace(source[cursor:end])) > 0) {
			code = append(code, line+1)
		} else if hasComment {
			commentLines++
		}
		start = end
	}
	return code, commentLines
}

type sourceLayout struct {
	tokens  *token.File
	offsets []int
	source  []byte
	rawEnds map[token.Pos]int
}

func (s *sourceLayout) fixRawStringEnds(file *ast.File) {
	if bytes.IndexByte(s.source, '\r') < 0 {
		return
	}
	ast.Inspect(file, func(node ast.Node) bool {
		literal, ok := node.(*ast.BasicLit)
		if !ok || !rawString(literal) {
			return true
		}
		position := literal.End()
		end := s.tokens.Offset(position)
		if s.source[end-1] != '`' {
			if s.rawEnds == nil {
				s.rawEnds = make(map[token.Pos]int)
			}
			// Go discards carriage returns from a raw string's AST value.
			s.rawEnds[position] = end + bytes.IndexByte(s.source[end:], '`') + 1
		}
		return true
	})
}

func (s sourceLayout) end(position token.Pos) int {
	if offset, found := s.rawEnds[position]; found {
		return offset
	}
	return s.tokens.Offset(position)
}

func rawString(literal *ast.BasicLit) bool {
	return literal.Kind == token.STRING && literal.Value[0] == '`'
}

func (s sourceLayout) line(offset int) int {
	return sort.SearchInts(s.offsets, offset+1)
}

type structureMetrics struct {
	layout         sourceLayout
	cyclomatic     []functionComplexity
	cognitive      []functionComplexity
	observations   []observation
	cognitiveTotal int
	anchors        []string
}

type flow struct {
	cognitive, cyclomatic, returns, maxDepth int
	deepest                                  ast.Node
}

func measureStructure(file *ast.File, layout sourceLayout) structureMetrics {
	metrics := structureMetrics{layout: layout, cyclomatic: []functionComplexity{},
		cognitive: []functionComplexity{}, observations: []observation{}}
	module := flow{}
	metrics.visit(file, &module, 0, token.ILLEGAL, false)
	if module.deepest != nil {
		metrics.observe("nested-control-flow", module.maxDepth, "Module control-flow depth", module.deepest)
	}
	metrics.cognitiveTotal += module.cognitive
	metrics.observations = append(metrics.observations, observation{
		Rule: "file-complexity", Value: metrics.cognitiveTotal, Label: "File cognitive complexity",
		Line: 1, EndLine: len(layout.offsets) - 1,
	})
	return metrics
}

// observe records an observation inside the innermost function being measured, or at module level.
func (m *structureMetrics) observe(rule string, value int, label string, node ast.Node) {
	anchor := ""
	if len(m.anchors) > 0 {
		anchor = m.anchors[len(m.anchors)-1]
	}
	m.observeAt(rule, value, label, node, anchor)
}

func (m *structureMetrics) observeAt(rule string, value int, label string, node ast.Node, anchor string) {
	start, end := m.layout.tokens.Offset(node.Pos()), m.layout.end(node.End())
	m.observations = append(m.observations, observation{
		Rule: rule, Value: value, Label: label, Line: m.layout.line(start), EndLine: m.layout.line(end - 1), Anchor: anchor,
	})
}

func (m *structureMetrics) visit(node ast.Node, frame *flow, depth int, logicalParent token.Token, chained bool) {
	switch node := node.(type) {
	case *ast.FuncDecl:
		m.measureFunction(node, node.Body, node.Type, methodName(node), frame, depth)
		return
	case *ast.FuncLit:
		m.measureFunction(node, node.Body, node.Type, "", frame, depth)
		return
	case *ast.ParenExpr:
		m.visit(node.X, frame, depth, logicalParent, false)
		return
	case *ast.CommentGroup:
		return
	}

	var logical token.Token
	block := false
	switch node := node.(type) {
	case *ast.IfStmt, *ast.ForStmt, *ast.RangeStmt:
		frame.cyclomatic++
		block = true
	case *ast.SwitchStmt, *ast.TypeSwitchStmt, *ast.SelectStmt:
		block = true
	case *ast.CaseClause:
		if node.List != nil {
			frame.cyclomatic++
		}
	case *ast.CommClause:
		if node.Comm != nil {
			frame.cyclomatic++
		}
	case *ast.ReturnStmt:
		frame.returns++
	case *ast.BranchStmt:
		if node.Label != nil {
			frame.cognitive++
		}
	case *ast.BinaryExpr:
		if isLogical(node.Op) {
			logical = node.Op
			frame.cyclomatic++
			if logicalParent != logical {
				frame.cognitive++
			}
			if !isLogical(logicalParent) {
				m.observe("boolean-logic", countLogicalOperators(node), "Logical operators in one expression", node)
			}
		}
	}

	childDepth := depth
	if block {
		frame.cognitive++
		if !chained {
			frame.cognitive += depth
		}
		childDepth++
		if childDepth > frame.maxDepth {
			frame.maxDepth, frame.deepest = childDepth, node
		}
	}
	forChildren(node, func(child ast.Node) {
		if conditional, ok := node.(*ast.IfStmt); ok && child == conditional.Else {
			if _, nextIf := child.(*ast.IfStmt); nextIf {
				m.visit(child, frame, depth, token.ILLEGAL, true)
			} else {
				frame.cognitive++
				m.visit(child, frame, childDepth, token.ILLEGAL, false)
			}
			return
		}
		m.visit(child, frame, childDepth, logical, false)
	})
}

func forChildren(node ast.Node, visit func(ast.Node)) {
	ast.Inspect(node, func(child ast.Node) bool {
		if child == node {
			return true
		}
		if child != nil {
			visit(child)
		}
		return false
	})
}

func isLogical(operator token.Token) bool {
	return operator == token.LAND || operator == token.LOR
}

func countLogicalOperators(node ast.Expr) int {
	switch node := node.(type) {
	case *ast.ParenExpr:
		return countLogicalOperators(node.X)
	case *ast.BinaryExpr:
		if isLogical(node.Op) {
			return 1 + countLogicalOperators(node.X) + countLogicalOperators(node.Y)
		}
	}
	return 0
}

func (m *structureMetrics) measureFunction(node ast.Node, body *ast.BlockStmt, signature *ast.FuncType, name string, outer *flow, depth int) {
	number := len(m.cyclomatic)
	offset := m.layout.tokens.Offset(node.Pos())
	line := m.layout.line(offset)
	position := functionComplexity{Name: name, Line: line, Column: offset - m.layout.offsets[line-1] + 1}
	m.cyclomatic = append(m.cyclomatic, position)
	m.cognitive = append(m.cognitive, position)

	anchor := name
	if anchor == "" {
		anchor = "(anonymous)"
		if len(m.anchors) > 0 {
			anchor = m.anchors[len(m.anchors)-1] + ".(anonymous)"
		}
	}
	own := flow{cyclomatic: 1}
	forChildren(node, func(child ast.Node) {
		if child == body {
			m.anchors = append(m.anchors, anchor)
			m.visit(child, &own, 0, token.ILLEGAL, false)
			m.anchors = m.anchors[:len(m.anchors)-1]
		} else {
			m.visit(child, outer, depth, token.ILLEGAL, false)
		}
	})
	m.cyclomatic[number].Value = own.cyclomatic
	m.cognitive[number].Value = own.cognitive
	m.cognitiveTotal += own.cognitive

	label := name
	if label == "" {
		label = "(anonymous)"
	}
	params := 0
	for _, field := range signature.Params.List {
		if len(field.Names) == 0 {
			params++
		} else {
			params += len(field.Names)
		}
	}
	m.observeAt("function-parameters", params, label+" · Parameters", node, anchor)
	m.observeAt("return-statements", own.returns, label+" · Return statements", node, anchor)
	m.observeAt("function-complexity", own.cognitive, label+" · Cognitive complexity", node, anchor)
	if own.deepest != nil {
		m.observeAt("nested-control-flow", own.maxDepth, label+" · Control-flow depth", own.deepest, anchor)
	}
}

func methodName(declaration *ast.FuncDecl) string {
	if declaration.Recv != nil && len(declaration.Recv.List) > 0 {
		if receiver := receiverName(declaration.Recv.List[0].Type); receiver != "" {
			return receiver + "." + declaration.Name.Name
		}
	}
	return declaration.Name.Name
}

func receiverName(expression ast.Expr) string {
	switch expression := expression.(type) {
	case *ast.Ident:
		return expression.Name
	case *ast.StarExpr:
		if name := receiverName(expression.X); name != "" {
			return "(*" + name + ")"
		}
	case *ast.IndexExpr:
		return receiverName(expression.X)
	case *ast.IndexListExpr:
		return receiverName(expression.X)
	case *ast.ParenExpr:
		return receiverName(expression.X)
	}
	return ""
}

type fingerprints struct {
	exact, similar [sha256.Size]byte
	nodes          int
}

var (
	nodeType     = reflect.TypeOf((*ast.Node)(nil)).Elem()
	positionType = reflect.TypeOf(token.NoPos)
)

func measureClones(path string, file *ast.File, layout sourceLayout, code []int, settings duplicationSettings) cloneSource {
	result := cloneSource{Path: path, Scheme: "repometry.go-ast/v1", CodeLines: code, Candidates: []candidate{}}
	if len(code) < settings.MinCodeLines {
		return result
	}

	var walk func(ast.Node) fingerprints
	walk = func(node ast.Node) fingerprints {
		nodes := 1
		syntax := reflect.ValueOf(node).Elem()
		exact := []byte(syntax.Type().Name())
		similar := []byte(syntax.Type().Name())

		addChild := func(field reflect.Value) {
			if field.IsNil() {
				exact = append(exact, 0)
				similar = append(similar, 0)
				return
			}
			hashes := walk(field.Interface().(ast.Node))
			nodes += hashes.nodes
			exact = append(append(exact, 1), hashes.exact[:]...)
			similar = append(append(similar, 1), hashes.similar[:]...)
		}

		for i := 0; i < syntax.NumField(); i++ {
			field, definition := syntax.Field(i), syntax.Type().Field(i)
			if !fingerprintField(definition) {
				continue
			}
			exact = append(append(exact, '|'), definition.Name...)
			similar = append(append(similar, '|'), definition.Name...)
			exact, similar = append(exact, ':'), append(similar, ':')

			switch {
			case definition.Type.Implements(nodeType):
				addChild(field)
			case field.Kind() == reflect.Slice:
				for j := 0; j < field.Len(); j++ {
					addChild(field.Index(j))
				}
			default:
				value := fingerprintValue(field, definition)
				if literal, ok := node.(*ast.BasicLit); definition.Name == "Value" && ok && rawString(literal) {
					value = string(layout.source[layout.tokens.Offset(literal.Pos()):layout.end(literal.End())])
				}
				exact = strconv.AppendQuote(exact, value)
				if normalizedField(node, definition.Name) {
					value = ""
				}
				similar = strconv.AppendQuote(similar, value)
			}
		}
		hashes := fingerprints{sha256.Sum256(exact), sha256.Sum256(similar), nodes}
		if nodes >= settings.MinNodes && cloneEligible(node) {
			start, end := layout.tokens.Offset(node.Pos()), layout.end(node.End())
			if end > start {
				line, endLine := layout.line(start), layout.line(end-1)
				count := sort.SearchInts(code, endLine+1) - sort.SearchInts(code, line)
				if count >= settings.MinCodeLines {
					result.Candidates = append(result.Candidates, candidate{
						Start: start, End: end, Line: line, EndLine: endLine, CodeLines: count, Nodes: nodes,
						Exact: base64.RawURLEncoding.EncodeToString(hashes.exact[:]), Similar: base64.RawURLEncoding.EncodeToString(hashes.similar[:]),
					})
				}
			}
		}
		return hashes
	}
	forChildren(file, func(child ast.Node) {
		if _, comment := child.(*ast.CommentGroup); !comment {
			walk(child)
		}
	})
	return result
}

func fingerprintField(field reflect.StructField) bool {
	switch field.Name {
	case "Doc", "Comment", "Comments", "Obj", "Scope", "Imports", "Unresolved", "GoVersion":
		return false
	}
	if field.Type == positionType {
		// These positions encode syntax not otherwise represented by an AST child or scalar.
		return field.Name == "Assign" || field.Name == "Ellipsis"
	}
	return true
}

func fingerprintValue(field reflect.Value, definition reflect.StructField) string {
	if definition.Type == positionType {
		return strconv.FormatBool(field.Interface().(token.Pos).IsValid())
	}
	switch field.Kind() {
	case reflect.String:
		return field.String()
	case reflect.Bool:
		return strconv.FormatBool(field.Bool())
	default:
		return strconv.FormatInt(field.Int(), 10)
	}
}

func normalizedField(node ast.Node, field string) bool {
	switch node.(type) {
	case *ast.Ident:
		return field == "Name"
	case *ast.BasicLit:
		return field == "Value"
	}
	return false
}

func cloneEligible(node ast.Node) bool {
	switch node := node.(type) {
	case *ast.EmptyStmt:
		return false
	case *ast.GenDecl:
		return node.Tok != token.IMPORT
	case ast.Stmt, *ast.FuncDecl, *ast.FuncLit:
		return true
	}
	return false
}
