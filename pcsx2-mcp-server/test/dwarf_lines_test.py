import importlib.util
from pathlib import Path
from types import SimpleNamespace as Obj
import unittest

spec = importlib.util.spec_from_file_location('dwarf_lines', Path(__file__).parents[1] / 'python/dwarf_lines.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def program(version, names, directories):
    return Obj(header=Obj(version=version, file_entry=[Obj(name=name, dir_index=index) for name, index in names], include_directory=directories))


class DwarfPathTests(unittest.TestCase):
    def test_legacy_file_index_is_one_based_and_directory_zero_uses_comp_dir(self):
        p = program(2, [(b'main.c', 0)], [])
        self.assertEqual(module.source_path(p, 1, '/build'), '/build/main.c')
        with self.assertRaisesRegex(ValueError, 'file index'):
            module.source_path(p, 0, '/build')

    def test_legacy_relative_directory_is_joined_to_comp_dir(self):
        p = program(4, [(b'main.c', 1)], [b'src'])
        self.assertEqual(module.source_path(p, 1, '/build'), '/build/src/main.c')

    def test_dwarf5_file_and_directory_indices_are_zero_based(self):
        p = program(5, [(b'main.c', 0), (b'other.c', 1)], [b'/build', b'/lib'])
        self.assertEqual(module.source_path(p, 0, '/wrong'), '/build/main.c')
        self.assertEqual(module.source_path(p, 1, '/wrong'), '/lib/other.c')

    def test_absolute_windows_and_unicode_filenames_are_preserved(self):
        p = program(5, [('C:\\fuente á\\main.c'.encode(), 0)], [b'/unused'])
        self.assertEqual(module.source_path(p, 0, '/build'), 'C:/fuente á/main.c')

    def test_invalid_directory_indices_are_explicit_errors(self):
        with self.assertRaisesRegex(ValueError, 'directory index'):
            module.source_path(program(2, [(b'a.c', 2)], [b'/one']), 1, '/build')
        with self.assertRaisesRegex(ValueError, 'directory index'):
            module.source_path(program(5, [(b'a.c', 1)], [b'/one']), 0, '/build')


if __name__ == '__main__':
    unittest.main()
