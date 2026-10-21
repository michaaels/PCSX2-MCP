import importlib.util
from pathlib import Path
from types import SimpleNamespace as Obj
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('dwarf_variables', Path(__file__).parents[1] / 'python/dwarf_variables.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def attribute(value, form='DW_FORM_addr', name='DW_AT_location'):
    return Obj(value=value, form=form, name=name)


def die(attrs=None, version=2):
    from elftools.dwarf.structs import DWARFStructs
    top = Obj(attributes={'DW_AT_low_pc': attribute(0x1000)})
    cu = Obj(header=Obj(version=version), structs=DWARFStructs(little_endian=True, dwarf_format=32, address_size=4, dwarf_version=version), get_top_DIE=lambda: top)
    return Obj(attributes=attrs or {}, cu=cu)


class LocationMetadataTests(unittest.TestCase):
    def test_high_pc_address_and_offset_have_distinct_meanings(self):
        metadata = module.Metadata(None, 0x1010)
        self.assertTrue(metadata.contains(die({'DW_AT_low_pc': attribute(0x1000), 'DW_AT_high_pc': attribute(0x1020)})))
        self.assertTrue(metadata.contains(die({'DW_AT_low_pc': attribute(0x1000), 'DW_AT_high_pc': attribute(0x20, 'DW_FORM_data4')})))
        self.assertFalse(metadata.contains(die({'DW_AT_low_pc': attribute(0x1000), 'DW_AT_high_pc': attribute(0x10, 'DW_FORM_data4')})))

    def test_location_lists_use_cu_base_selection_and_half_open_intervals(self):
        dwarf = Obj(location_lists=lambda: None)
        metadata = module.Metadata(dwarf, 0x2010)
        entries = [Obj(base_address=0x2000), Obj(begin_offset=0x10, end_offset=0x20, is_absolute=False, loc_expr=[0x54])]
        with patch('elftools.dwarf.locationlists.LocationParser') as parser:
            parser.return_value.parse_from_attribute.return_value = entries
            target = die({'DW_AT_location': attribute(0)})
            self.assertEqual(metadata.location(target)['ops'], [{'op': 'DW_OP_reg4', 'args': []}])
            metadata.pc = 0x2020
            self.assertEqual(metadata.location(target)['status'], 'not_live_at_pc')

    def test_overlapping_location_intervals_are_not_arbitrarily_selected(self):
        metadata = module.Metadata(Obj(location_lists=lambda: None), 0x1001)
        entries = [Obj(begin_offset=0, end_offset=4, is_absolute=False, loc_expr=[0x54])] * 2
        with patch('elftools.dwarf.locationlists.LocationParser') as parser:
            parser.return_value.parse_from_attribute.return_value = entries
            self.assertEqual(metadata.location(die({'DW_AT_location': attribute(0)}))['status'], 'ambiguous_location')

    def test_expression_arguments_preserve_unsigned_64_bits_as_decimal_strings(self):
        metadata = module.Metadata(None, 0)
        result = metadata.ops(die(), [0x0e] + list(bytes.fromhex('1032547698badcfe')) + [0x9f])
        self.assertEqual(result['ops'][0]['args'], ['18364758544493064720'])
        self.assertEqual(result['ops'][1]['op'], 'DW_OP_stack_value')

    def test_missing_locations_and_numeric_constants_are_distinguished(self):
        metadata = module.Metadata(None, 0)
        self.assertEqual(metadata.location(die())['status'], 'location_unavailable')
        self.assertEqual(metadata.location(die({'DW_AT_const_value': attribute(-7)})), {'status': 'constant', 'value': '-7'})

    def test_unsupported_scope_start_and_location_views_are_not_ignored(self):
        metadata = module.Metadata(None, 0)
        self.assertEqual(metadata.location(die({'DW_AT_start_scope': attribute(0)}))['status'], 'unsupported_start_scope')
        self.assertEqual(metadata.location(die({'DW_AT_GNU_locviews': attribute(0)}))['status'], 'unsupported_location_views')

    def test_unsupported_nested_expressions_and_excessive_bytes_are_explicit(self):
        metadata = module.Metadata(None, 0)
        self.assertEqual(metadata.ops(die(), [0x9e, 1, 7])['status'], 'unsupported_expression')
        self.assertEqual(metadata.ops(die(), [0x96] * 513)['status'], 'unsupported_expression')

    def test_only_active_lexical_scopes_are_selected_and_inline_children_are_not_fabricated(self):
        def scope(tag, offset, start, end, children=(), name=b'scope'):
            result = die({'DW_AT_low_pc': attribute(start), 'DW_AT_high_pc': attribute(end), 'DW_AT_name': attribute(name)})
            result.tag, result.offset, result.iter_children = tag, offset, lambda: iter(children)
            return result
        local = scope('DW_TAG_variable', 2, 0, 0, name=b'inner')
        active = scope('DW_TAG_lexical_block', 3, 0x1010, 0x1020, [local])
        inactive = scope('DW_TAG_lexical_block', 4, 0x1030, 0x1040, [local])
        inline = scope('DW_TAG_inlined_subroutine', 5, 0x1010, 0x1020, [local], b'inlined')
        function = scope('DW_TAG_subprogram', 1, 0x1000, 0x1100, [active, inactive, inline])
        metadata = module.Metadata(Obj(line_program_for_CU=lambda _: None, has_CFI=lambda: False), 0x1015)
        with patch.object(metadata, 'type_ref', return_value=None):
            result = metadata.frame(function)
            self.assertEqual([var['scope'] for var in result['variables']], ['3'])
            self.assertEqual(result['inline_scopes'][0]['status'], 'unsupported_inline_scope')
            metadata.pc = 0x1020
            self.assertEqual(metadata.frame(function)['variables'], [])


if __name__ == '__main__':
    unittest.main()
